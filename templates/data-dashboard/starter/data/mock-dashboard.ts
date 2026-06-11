export type Metric = {
  label: string;
  value: string;
  delta: string;
  tone: "positive" | "warning" | "neutral";
};

export type RankingItem = {
  label: string;
  value: string;
  percent: number;
};

export const dashboardMetrics: Metric[] = [
  { label: "Active Devices", value: "128,640", delta: "+12.4%", tone: "positive" },
  { label: "Realtime Throughput", value: "8.72M", delta: "+6.8%", tone: "positive" },
  { label: "Risk Alerts", value: "316", delta: "-3.1%", tone: "warning" },
  { label: "SLA Compliance", value: "99.93%", delta: "+0.4%", tone: "neutral" }
];

export const trafficTrend = [
  { time: "00:00", inbound: 42, outbound: 34, incidents: 12 },
  { time: "03:00", inbound: 48, outbound: 39, incidents: 10 },
  { time: "06:00", inbound: 61, outbound: 44, incidents: 9 },
  { time: "09:00", inbound: 86, outbound: 72, incidents: 15 },
  { time: "12:00", inbound: 112, outbound: 96, incidents: 18 },
  { time: "15:00", inbound: 124, outbound: 105, incidents: 21 },
  { time: "18:00", inbound: 118, outbound: 101, incidents: 17 },
  { time: "21:00", inbound: 94, outbound: 82, incidents: 13 }
];

export const regionalLoad = [
  { region: "North", load: 78 },
  { region: "East", load: 91 },
  { region: "South", load: 84 },
  { region: "West", load: 69 },
  { region: "Central", load: 88 }
];

export const channelShare = [
  { name: "Web", value: 38 },
  { name: "Mobile", value: 31 },
  { name: "API", value: 21 },
  { name: "IoT", value: 10 }
];

export const slaSnapshot = {
  name: "SLA",
  value: 99.93
};

export const rankingItems: RankingItem[] = [
  { label: "Shanghai Command Hub", value: "23.8M", percent: 94 },
  { label: "Beijing North Region", value: "19.4M", percent: 82 },
  { label: "Shenzhen Edge Cluster", value: "17.9M", percent: 76 },
  { label: "Chengdu Service Grid", value: "13.7M", percent: 64 },
  { label: "Hangzhou Data Node", value: "11.2M", percent: 55 }
];

export const tickerItems = [
  "North region throughput recovered to target band",
  "Edge cache hit rate holds above 96% for 30 minutes",
  "Three alert queues require operator acknowledgement",
  "Forecast model refreshed from deterministic demo dataset"
];
