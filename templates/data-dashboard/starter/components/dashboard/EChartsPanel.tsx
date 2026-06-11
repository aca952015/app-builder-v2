"use client";

import type { EChartsOption, EChartsType } from "echarts";
import { useEffect, useRef } from "react";

type EChartsPanelProps = {
  option: EChartsOption;
  title: string;
  className?: string;
};

export function EChartsPanel({ option, title, className }: EChartsPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const latestOptionRef = useRef(option);

  useEffect(() => {
    latestOptionRef.current = option;
    chartRef.current?.setOption(option, true);
  }, [option]);

  useEffect(() => {
    let disposed = false;

    async function mountChart() {
      if (!containerRef.current || chartRef.current) {
        return;
      }

      const echarts = await import("echarts");
      if (disposed || !containerRef.current) {
        return;
      }

      chartRef.current = echarts.init(containerRef.current, "dark", { renderer: "canvas" });
      chartRef.current.setOption(latestOptionRef.current, true);
    }

    void mountChart();

    return () => {
      disposed = true;
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const observer = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={className ?? "h-64 w-full"}
      role="img"
      aria-label={title}
    />
  );
}
