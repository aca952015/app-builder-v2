import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

export type ManagedDevServerProcess = {
  child: ChildProcess;
  command: string;
  args: string[];
  cwd: string;
  spawnedAt: string;
  pid?: number;
  processGroupId?: number;
};

export type DevServerProcessCleanupResult = {
  attempted: boolean;
  exited: boolean;
  forced: boolean;
  killedPids: number[];
  errors: string[];
  pid?: number;
  processGroupId?: number;
};

const DEFAULT_TERMINATE_TIMEOUT_MS = 10_000;
const PROCESS_EXIT_POLL_INTERVAL_MS = 100;

function asErrnoException(error: unknown): NodeJS.ErrnoException | null {
  return error instanceof Error ? error as NodeJS.ErrnoException : null;
}

function isNoSuchProcessError(error: unknown): boolean {
  return asErrnoException(error)?.code === "ESRCH";
}

function isPermissionError(error: unknown): boolean {
  return asErrnoException(error)?.code === "EPERM";
}

function signalErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const code = asErrnoException(error)?.code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

export function isChildProcessRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && child.killed !== true;
}

export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionError(error);
  }
}

export function spawnManagedDevServerProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): ManagedDevServerProcess {
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: useProcessGroup,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const managed: ManagedDevServerProcess = {
    child,
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    spawnedAt: new Date().toISOString(),
  };
  if (child.pid !== undefined) {
    managed.pid = child.pid;
    if (useProcessGroup) {
      managed.processGroupId = child.pid;
    }
  }
  return managed;
}

async function listDescendantPids(rootPid: number): Promise<number[]> {
  if (process.platform === "win32") {
    return [];
  }

  return await new Promise<number[]>((resolve) => {
    const child = spawn("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", () => resolve([]));
    child.once("exit", (exitCode) => {
      if (exitCode !== 0) {
        resolve([]);
        return;
      }

      const childrenByParent = new Map<number, number[]>();
      for (const line of output.split(/\r?\n/)) {
        const [rawPid, rawParentPid] = line.trim().split(/\s+/);
        const pid = Number(rawPid);
        const parentPid = Number(rawParentPid);
        if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) {
          continue;
        }
        const children = childrenByParent.get(parentPid) ?? [];
        children.push(pid);
        childrenByParent.set(parentPid, children);
      }

      const descendants: number[] = [];
      const stack = [...(childrenByParent.get(rootPid) ?? [])];
      while (stack.length > 0) {
        const pid = stack.pop();
        if (pid === undefined || descendants.includes(pid)) {
          continue;
        }
        descendants.push(pid);
        stack.push(...(childrenByParent.get(pid) ?? []));
      }
      resolve(descendants);
    });
  });
}

function signalPid(
  pid: number,
  signal: NodeJS.Signals,
  signaledPids: Set<number>,
  errors: string[],
): void {
  try {
    process.kill(pid, signal);
    signaledPids.add(pid);
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      errors.push(`Failed to send ${signal} to PID ${pid}: ${signalErrorSummary(error)}`);
    }
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
  errors: string[],
): boolean {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      errors.push(`Failed to send ${signal} to process group ${processGroupId}: ${signalErrorSummary(error)}`);
    }
    return false;
  }
}

async function runTaskkill(pid: number, force: boolean, errors: string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const child = spawn("taskkill", args, { stdio: "ignore" });
    child.once("error", (error) => {
      errors.push(`Failed to run taskkill for PID ${pid}: ${signalErrorSummary(error)}`);
      resolve();
    });
    child.once("exit", () => resolve());
  });
}

async function signalProcessTree(options: {
  pid: number;
  signal: NodeJS.Signals;
  processGroupId?: number;
  signaledPids: Set<number>;
  errors: string[];
}): Promise<number[]> {
  if (process.platform === "win32") {
    await runTaskkill(options.pid, options.signal === "SIGKILL", options.errors);
    options.signaledPids.add(options.pid);
    return [options.pid];
  }

  if (
    options.processGroupId !== undefined
    && signalProcessGroup(options.processGroupId, options.signal, options.errors)
  ) {
    options.signaledPids.add(options.pid);
    return [options.pid];
  }

  const descendants = await listDescendantPids(options.pid);
  const pids = [...descendants.reverse(), options.pid];
  for (const pid of pids) {
    signalPid(pid, options.signal, options.signaledPids, options.errors);
  }
  return pids;
}

async function waitForPidsExit(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isPidRunning(pid))) {
      return true;
    }
    await sleep(PROCESS_EXIT_POLL_INTERVAL_MS);
  }
  return pids.every((pid) => !isPidRunning(pid));
}

export async function terminateProcessTreeByPid(options: {
  pid: number;
  processGroupId?: number;
  timeoutMs?: number;
}): Promise<DevServerProcessCleanupResult> {
  const errors: string[] = [];
  const signaledPids = new Set<number>();
  const baseResult = {
    ...(options.processGroupId !== undefined ? { processGroupId: options.processGroupId } : {}),
    pid: options.pid,
  };

  if (!Number.isInteger(options.pid) || options.pid <= 0 || !isPidRunning(options.pid)) {
    return {
      ...baseResult,
      attempted: false,
      exited: true,
      forced: false,
      killedPids: [],
      errors,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS;
  const termPids = await signalProcessTree({
    pid: options.pid,
    signal: "SIGTERM",
    ...(options.processGroupId !== undefined ? { processGroupId: options.processGroupId } : {}),
    signaledPids,
    errors,
  });
  if (await waitForPidsExit(termPids, timeoutMs)) {
    return {
      ...baseResult,
      attempted: true,
      exited: true,
      forced: false,
      killedPids: [...signaledPids].sort((a, b) => a - b),
      errors,
    };
  }

  const killPids = await signalProcessTree({
    pid: options.pid,
    signal: "SIGKILL",
    ...(options.processGroupId !== undefined ? { processGroupId: options.processGroupId } : {}),
    signaledPids,
    errors,
  });

  return {
    ...baseResult,
    attempted: true,
    exited: await waitForPidsExit(killPids, timeoutMs),
    forced: true,
    killedPids: [...signaledPids].sort((a, b) => a - b),
    errors,
  };
}

export async function terminateDevServerProcess(
  child: ChildProcess,
  options: {
    processGroupId?: number;
    timeoutMs?: number;
  } = {},
): Promise<DevServerProcessCleanupResult> {
  const pid = child.pid;
  if (pid === undefined || !isChildProcessRunning(child)) {
    return {
      ...(pid !== undefined ? { pid } : {}),
      ...(options.processGroupId !== undefined ? { processGroupId: options.processGroupId } : {}),
      attempted: false,
      exited: true,
      forced: false,
      killedPids: [],
      errors: [],
    };
  }

  const exitPromise = once(child, "exit").catch(() => undefined);
  const cleanup = await terminateProcessTreeByPid({
    pid,
    ...(options.processGroupId !== undefined ? { processGroupId: options.processGroupId } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  await Promise.race([exitPromise, sleep(PROCESS_EXIT_POLL_INTERVAL_MS)]);
  return cleanup;
}

export async function terminateManagedDevServerProcess(
  managed: ManagedDevServerProcess,
  options: { timeoutMs?: number } = {},
): Promise<DevServerProcessCleanupResult> {
  return await terminateDevServerProcess(managed.child, {
    ...(managed.processGroupId !== undefined ? { processGroupId: managed.processGroupId } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
