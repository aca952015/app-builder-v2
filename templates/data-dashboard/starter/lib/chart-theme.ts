import type { EChartsOption } from "echarts";

const textColor = "#dff6ff";
const mutedColor = "#8ab4cc";
const splitLineColor = "rgba(125, 211, 252, 0.12)";
const palette = ["#38bdf8", "#22d3ee", "#34d399", "#fbbf24", "#a78bfa"];

const baseGrid = {
  left: 36,
  right: 18,
  top: 40,
  bottom: 28,
};

export type TrafficTrendPoint = {
  time: string;
  inbound: number;
  outbound: number;
  incidents: number;
};

export type RegionalLoadPoint = {
  region: string;
  load: number;
};

export type ChannelSharePoint = {
  name: string;
  value: number;
};

export type GaugeSnapshot = {
  name: string;
  value: number;
};

export function buildTrafficTrendOption(trafficTrendData: TrafficTrendPoint[]): EChartsOption {
  return {
    color: palette,
    tooltip: { trigger: "axis" },
    legend: {
      top: 0,
      right: 0,
      textStyle: { color: mutedColor },
    },
    grid: baseGrid,
    xAxis: {
      type: "category",
      data: trafficTrendData.map((point) => point.time),
      axisLine: { lineStyle: { color: splitLineColor } },
      axisLabel: { color: mutedColor },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: mutedColor },
      splitLine: { lineStyle: { color: splitLineColor } },
    },
    series: [
      {
        name: "Inbound",
        type: "line",
        smooth: true,
        areaStyle: { opacity: 0.16 },
        data: trafficTrendData.map((point) => point.inbound),
      },
      {
        name: "Outbound",
        type: "line",
        smooth: true,
        areaStyle: { opacity: 0.1 },
        data: trafficTrendData.map((point) => point.outbound),
      },
      {
        name: "Incidents",
        type: "bar",
        barWidth: 8,
        data: trafficTrendData.map((point) => point.incidents),
      },
    ],
  };
}

export function buildRegionalLoadOption(regionalLoadData: RegionalLoadPoint[]): EChartsOption {
  return {
    color: palette,
    tooltip: { trigger: "axis" },
    grid: { left: 38, right: 18, top: 24, bottom: 32 },
    xAxis: {
      type: "category",
      data: regionalLoadData.map((item) => item.region),
      axisLine: { lineStyle: { color: splitLineColor } },
      axisLabel: { color: mutedColor },
    },
    yAxis: {
      type: "value",
      max: 100,
      axisLabel: { color: mutedColor, formatter: "{value}%" },
      splitLine: { lineStyle: { color: splitLineColor } },
    },
    series: [
      {
        name: "Load",
        type: "bar",
        barWidth: 18,
        data: regionalLoadData.map((item) => item.load),
        itemStyle: {
          borderRadius: [8, 8, 0, 0],
        },
      },
    ],
  };
}

export function buildChannelShareOption(channelShareData: ChannelSharePoint[]): EChartsOption {
  return {
    color: palette,
    tooltip: { trigger: "item" },
    legend: {
      bottom: 0,
      left: "center",
      textStyle: { color: mutedColor },
    },
    series: [
      {
        name: "Channel Share",
        type: "pie",
        radius: ["46%", "70%"],
        center: ["50%", "44%"],
        avoidLabelOverlap: true,
        label: { color: textColor, formatter: "{b} {d}%" },
        labelLine: { lineStyle: { color: splitLineColor } },
        data: channelShareData,
      },
    ],
  };
}

export function buildSlaGaugeOption(snapshot: GaugeSnapshot): EChartsOption {
  return {
    series: [
      {
        type: "gauge",
        startAngle: 210,
        endAngle: -30,
        min: 0,
        max: 100,
        progress: { show: true, width: 14, itemStyle: { color: "#34d399" } },
        axisLine: { lineStyle: { width: 14, color: [[1, "rgba(125, 211, 252, 0.16)"]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        detail: {
          valueAnimation: true,
          formatter: "{value}%",
          color: textColor,
          fontSize: 34,
          offsetCenter: [0, "8%"],
        },
        title: {
          color: mutedColor,
          offsetCenter: [0, "58%"],
        },
        data: [{ value: snapshot.value, name: snapshot.name }],
      },
    ],
  };
}
