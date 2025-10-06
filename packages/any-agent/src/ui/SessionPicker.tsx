import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { BarChart, Sparkline, type BarChartData } from "@pppp606/ink-chart";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { SessionSummary } from "../codex";
import {
  CODEX_BRAND_COLOR,
  codexSessionToUnifiedTranscript,
} from "../codex";
import {
  CLAUDE_CODE_BRAND_COLOR,
  claudeCodeSessionToUnifiedTranscript,
} from "../claudecode";
import { formatUsd } from "../pricing";

const HEADER_FOOTPRINT = 2;
const STATUS_LINE_FOOTPRINT = 2;
const HEADER_COLOR = "gray";
const KEY_COLOR = "cyan";
const MESSAGE_COLOR = "white";
const INDICATOR_WIDTH = 1;
const LEADING_SPACE = 1;
const SEPARATOR_WIDTH = 3;

type ColumnKey = "time" | "model" | "tokens" | "repo" | "message";

const BASE_WIDTHS: Record<ColumnKey, number> = {
  time: 18,
  model: 22,
  tokens: 8,
  repo: 28,
  message: 80,
};

const MIN_WIDTHS: Record<ColumnKey, number> = {
  time: 14,
  model: 12,
  tokens: 5,
  repo: 18,
  message: 20,
};

const ABS_MIN_WIDTHS: Record<ColumnKey, number> = {
  time: 6,
  model: 4,
  tokens: 4,
  repo: 6,
  message: 0,
};

const SHRINK_ORDER: ColumnKey[] = [
  "message",
  "repo",
  "tokens",
  "model",
  "time",
];

const HIDE_ORDER: Array<Exclude<ColumnKey, "time" | "message">> = [
  "repo",
  "tokens",
  "model",
];

interface TableLayout {
  timeWidth: number;
  modelWidth: number;
  tokensWidth: number;
  repoWidth: number;
  messageWidth: number;
  showModel: boolean;
  showTokens: boolean;
  showRepo: boolean;
}

const useTerminalDimensions = (): [number | undefined, number | undefined] => {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState<
    [number | undefined, number | undefined]
  >(() => [stdout?.columns, stdout?.rows]);

  useEffect(() => {
    if (!stdout) {
      return;
    }

    const handleResize = () => {
      setDimensions([stdout.columns, stdout.rows]);
    };

    handleResize();
    stdout.on("resize", handleResize);

    return () => {
      if (typeof stdout.off === "function") {
        stdout.off("resize", handleResize);
      } else {
        stdout.removeListener("resize", handleResize);
      }
    };
  }, [stdout]);

  return dimensions;
};

interface SessionPickerProps {
  sessions: SessionSummary[];
  totalTokens: number;
  totalCost: number;
  initialYoloMode?: boolean;
  onResume?: (session: SessionSummary, yoloMode: boolean) => void;
}

export const SessionPicker: React.FC<SessionPickerProps> = ({
  sessions,
  totalTokens,
  totalCost,
  initialYoloMode = false,
  onResume,
}) => {
  const { exit } = useApp();
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [yoloMode, setYoloMode] = useState(initialYoloMode);
  const [stdoutColumns, stdoutRows] = useTerminalDimensions();
  const columns = stdoutColumns ?? 80;
  const rows = stdoutRows ?? 24;
  const layout = useMemo(() => computeLayout(columns), [columns]);
  const chartMetrics = useMemo(
    () => computeChartMetrics(sessions, columns),
    [sessions, columns]
  );
  const hasSparkline = chartMetrics.sparkline.hasActivity;
  const hasProviderBars = chartMetrics.providerBars.length > 0;
  const showCharts = hasSparkline || hasProviderBars;

  const homeDir = useMemo(() => os.homedir(), []);
  const hasSessions = sessions.length > 0;
  const headerSummary = useMemo(() => {
    return "🤖 Any Agent History";
  }, []);
  const availableHeight = Math.max(
    rows - HEADER_FOOTPRINT - STATUS_LINE_FOOTPRINT - chartMetrics.footprint,
    1
  );
  const limit = hasSessions
    ? Math.max(Math.min(availableHeight, sessions.length), 1)
    : 0;
  const maxOffset = Math.max(0, sessions.length - limit);

  useEffect(() => {
    if (!hasSessions) {
      setHighlightedIndex(0);
      setOffset(0);
      return;
    }

    if (highlightedIndex >= sessions.length) {
      const nextIndex = sessions.length - 1;
      setHighlightedIndex(nextIndex);
      setOffset(
        clampOffset(nextIndex - limit + 1, Math.max(0, sessions.length - limit))
      );
    }
  }, [hasSessions, highlightedIndex, limit, sessions.length]);

  useInput((input, key) => {
    if (!hasSessions) {
      if (key.return) {
        exit();
      }
      return;
    }

    // Check for Ctrl+Enter via raw escape sequence
    if (input === "[27;5;13~") {
      const session = sessions[highlightedIndex];
      if (session) {
        const transcript =
          session.source === "claude-code"
            ? claudeCodeSessionToUnifiedTranscript(session)
            : codexSessionToUnifiedTranscript(session);

        console.error("=== TRANSCRIPT DATA ===");
        console.error(JSON.stringify(transcript, null, 2));

        // Save to ./tmp directory
        const tmpDir = path.join(process.cwd(), "tmp");
        if (!fs.existsSync(tmpDir)) {
          fs.mkdirSync(tmpDir, { recursive: true });
        }

        const timestamp = new Date()
          .toISOString()
          .replace(/:/g, "-")
          .replace(/\..+/, "");
        const filename = `transcript-${timestamp}.json`;
        const filePath = path.join(tmpDir, filename);

        fs.writeFileSync(filePath, JSON.stringify(transcript, null, 2), "utf-8");
        console.error(`Saved transcript to: ${filePath}`);
      }
      return;
    }

    if (key.upArrow || input === "k") {
      setHighlightedIndex((prev) => {
        const next = (prev - 1 + sessions.length) % sessions.length;
        setOffset((current) =>
          clampOffset(next < current ? next : current, maxOffset)
        );
        return next;
      });
    } else if (key.downArrow || input === "j") {
      setHighlightedIndex((prev) => {
        const next = (prev + 1) % sessions.length;
        setOffset((current) => {
          if (next >= current + limit) {
            return clampOffset(next - limit + 1, maxOffset);
          }
          return current;
        });
        return next;
      });
    } else if (key.tab) {
      setYoloMode((prev) => !prev);
    } else if (key.return) {
      const session = sessions[highlightedIndex];
      if (session) {
        onResume?.(session, yoloMode);
      }
      exit();
    }
  });

  const effectiveOffset = Math.min(offset, maxOffset);
  const visibleSessions = useMemo(() => {
    if (!hasSessions) {
      return [];
    }
    return sessions
      .slice(effectiveOffset, effectiveOffset + limit)
      .map((session, index) => ({
        session,
        absoluteIndex: effectiveOffset + index,
      }));
  }, [effectiveOffset, hasSessions, limit, sessions]);

  return (
    <Box flexDirection="column">
      <Text color={MESSAGE_COLOR}>{headerSummary}</Text>
      {showCharts ? (
        <Box flexDirection="column">
          {hasSparkline ? (
            <>
              <Text color={HEADER_COLOR}>
                {`${formatSiSuffix(totalTokens)} total tokens${
                  totalCost > 0
                    ? ` · ${formatUsd(totalCost).replace("$", "")} total costs`
                    : ""
                }${
                  chartMetrics.sparkline.peakDay
                    ? ` · peak ${chartMetrics.sparkline.peakDay}`
                    : ""
                }`}
              </Text>
              <Box width={Math.max(columns, 1)} justifyContent="flex-end">
                <Sparkline
                  data={chartMetrics.sparkline.points}
                  width={Math.max(chartMetrics.sparkline.points.length, 1)}
                  colorScheme="blue"
                />
              </Box>
              <Box width={Math.max(columns, 1)} justifyContent="flex-end">
                <Text color={HEADER_COLOR}>
                  {`total usage in the last ${chartMetrics.sparkline.dayCount} days`}
                </Text>
              </Box>
            </>
          ) : null}
          {hasProviderBars ? (
            <>
              <Text color={HEADER_COLOR}>Tokens by provider</Text>
              <BarChart
                data={chartMetrics.providerBars}
                width={Math.max(columns, 1)}
                sort="desc"
                showValue="right"
                format={(value) => `${formatSiSuffix(value)} tokens`}
              />
            </>
          ) : null}
        </Box>
      ) : null}
      {hasSessions ? (
        <>
          {visibleSessions.map(({ session, absoluteIndex }) => (
            <SessionRow
              key={session.id}
              session={session}
              isSelected={absoluteIndex === highlightedIndex}
              homeDir={homeDir}
              layout={layout}
            />
          ))}
        </>
      ) : (
        <Box marginTop={1}>
          <Text color={MESSAGE_COLOR}>No agent sessions found.</Text>
        </Box>
      )}
      <StatusLine
        selectedSession={sessions[highlightedIndex]}
        yoloMode={yoloMode}
      />
    </Box>
  );
};

interface SessionRowProps {
  session: SessionSummary;
  isSelected: boolean;
  homeDir: string;
  layout: TableLayout;
}

const SessionRow: React.FC<SessionRowProps> = ({
  session,
  isSelected,
  homeDir,
  layout,
}) => {
  const meta = session.meta ?? {};
  const cwdValue = typeof meta.cwd === "string" ? meta.cwd : undefined;
  const projectPathValue =
    typeof (meta as Record<string, unknown>).projectPath === "string"
      ? ((meta as Record<string, unknown>).projectPath as string)
      : undefined;
  const cwd = cwdValue ?? projectPathValue ?? ".";
  const repoPath = formatPath(cwd, homeDir);
  const timestamp = pad(
    truncate(session.relativeTime, layout.timeWidth),
    layout.timeWidth
  );
  const modelLabel = formatModelLabel(session);
  const modelColumn = layout.showModel
    ? pad(truncate(modelLabel, layout.modelWidth), layout.modelWidth)
    : "";
  const tokensLabel =
    session.blendedTokens > 0 ? formatSiSuffix(session.blendedTokens) : "";
  const tokensColumn = layout.showTokens
    ? pad(truncate(tokensLabel, layout.tokensWidth), layout.tokensWidth)
    : "";
  const repoColumn = layout.showRepo
    ? pad(truncate(repoPath, layout.repoWidth), layout.repoWidth)
    : "";
  const baseMessage = session.preview ?? "(no user message)";
  const marker = session.branchMarker?.trim().length
    ? session.branchMarker
    : " ";
  const messageWithoutMarker = truncate(
    baseMessage,
    Math.max(0, layout.messageWidth - 2)
  );
  const indicator = isSelected ? "➤" : " ";

  const leftColor = isSelected ? MESSAGE_COLOR : HEADER_COLOR;
  const brandColor =
    session.source === "claude-code"
      ? CLAUDE_CODE_BRAND_COLOR
      : CODEX_BRAND_COLOR;

  return (
    <Box>
      <Text color={isSelected ? brandColor : HEADER_COLOR}>{indicator}</Text>
      <Text color={leftColor}>{` ${timestamp}`}</Text>
      {layout.showModel && (
        <>
          <Text color={HEADER_COLOR}> │ </Text>
          {isSelected ? (
            <>
              <Text color={brandColor}>
                {session.source === "claude-code" ? "Claude Code" : "Codex"}
              </Text>
              <Text color={leftColor}>
                {modelColumn.replace("Claude Code", "").replace("Codex", "")}
              </Text>
            </>
          ) : (
            <Text color={leftColor}>{modelColumn}</Text>
          )}
        </>
      )}
      {layout.showTokens && (
        <>
          <Text color={HEADER_COLOR}> │ </Text>
          <Text color={leftColor}>{tokensColumn}</Text>
        </>
      )}
      {layout.showRepo && (
        <>
          <Text color={HEADER_COLOR}> │ </Text>
          <Text color={leftColor}>{repoColumn}</Text>
        </>
      )}
      {layout.messageWidth > 0 && (
        <>
          <Text color={HEADER_COLOR}> │ </Text>
          <Text color={HEADER_COLOR}>{marker}</Text>
          <Text color={HEADER_COLOR}> </Text>
          <Text color={isSelected ? brandColor : MESSAGE_COLOR}>
            {messageWithoutMarker}
          </Text>
        </>
      )}
    </Box>
  );
};

const computeLayout = (columns: number): TableLayout => {
  const effectiveColumns = Math.max(columns, 1);
  const layout: TableLayout = {
    timeWidth: BASE_WIDTHS.time,
    modelWidth: BASE_WIDTHS.model,
    tokensWidth: BASE_WIDTHS.tokens,
    repoWidth: BASE_WIDTHS.repo,
    messageWidth: BASE_WIDTHS.message,
    showModel: true,
    showTokens: true,
    showRepo: true,
  };

  shrinkToFit(layout, effectiveColumns, MIN_WIDTHS);

  for (const key of HIDE_ORDER) {
    if (totalWidth(layout) <= effectiveColumns) {
      break;
    }
    if (key === "repo" && layout.showRepo) {
      layout.showRepo = false;
    } else if (key === "tokens" && layout.showTokens) {
      layout.showTokens = false;
    } else if (key === "model" && layout.showModel) {
      layout.showModel = false;
    }
    shrinkToFit(layout, effectiveColumns, MIN_WIDTHS);
  }

  if (totalWidth(layout) > effectiveColumns) {
    shrinkToFit(layout, effectiveColumns, ABS_MIN_WIDTHS);
  }

  adjustMessageWidth(layout, effectiveColumns);

  return layout;
};

const totalWidth = (layout: TableLayout): number => {
  const columnWidths = [Math.max(layout.timeWidth, 0)];
  if (layout.showModel) {
    columnWidths.push(Math.max(layout.modelWidth, 0));
  }
  if (layout.showTokens) {
    columnWidths.push(Math.max(layout.tokensWidth, 0));
  }
  if (layout.showRepo) {
    columnWidths.push(Math.max(layout.repoWidth, 0));
  }
  columnWidths.push(Math.max(layout.messageWidth, 0));

  const separators = columnWidths.length - 1;
  const sum = columnWidths.reduce((acc, width) => acc + width, 0);
  return INDICATOR_WIDTH + LEADING_SPACE + sum + separators * SEPARATOR_WIDTH;
};

const shrinkToFit = (
  layout: TableLayout,
  columns: number,
  bounds: Record<ColumnKey, number>
) => {
  let changed = true;
  while (totalWidth(layout) > columns && changed) {
    changed = false;
    for (const key of SHRINK_ORDER) {
      if (!columnIsVisible(layout, key)) {
        continue;
      }
      const prop = KEY_TO_PROP[key];
      const current = layout[prop];
      const minimum = bounds[key];
      if (current > minimum) {
        const overflow = totalWidth(layout) - columns;
        const reductions = Math.min(current - minimum, overflow);
        if (reductions > 0) {
          layout[prop] = current - reductions;
          changed = true;
        }
      }
      if (totalWidth(layout) <= columns) {
        break;
      }
    }
  }
};

const adjustMessageWidth = (layout: TableLayout, columns: number) => {
  const leftColumns: number[] = [layout.timeWidth];
  if (layout.showModel) {
    leftColumns.push(layout.modelWidth);
  }
  if (layout.showTokens) {
    leftColumns.push(layout.tokensWidth);
  }
  if (layout.showRepo) {
    leftColumns.push(layout.repoWidth);
  }

  const separators = leftColumns.length; // message column adds one more separator
  const baseWidth =
    INDICATOR_WIDTH +
    LEADING_SPACE +
    leftColumns.reduce((acc, width) => acc + Math.max(width, 0), 0) +
    separators * SEPARATOR_WIDTH;

  const available = columns - baseWidth;
  layout.messageWidth = Math.max(0, available);
};

const KEY_TO_PROP: Record<
  ColumnKey,
  keyof Pick<
    TableLayout,
    "timeWidth" | "modelWidth" | "tokensWidth" | "repoWidth" | "messageWidth"
  >
> = {
  time: "timeWidth",
  model: "modelWidth",
  tokens: "tokensWidth",
  repo: "repoWidth",
  message: "messageWidth",
};

const columnIsVisible = (layout: TableLayout, key: ColumnKey): boolean => {
  if (key === "model") {
    return layout.showModel;
  }
  if (key === "tokens") {
    return layout.showTokens;
  }
  if (key === "repo") {
    return layout.showRepo;
  }
  return true;
};

interface StatusLineProps {
  selectedSession?: SessionSummary;
  yoloMode: boolean;
}

const StatusLine: React.FC<StatusLineProps> = ({
  selectedSession,
  yoloMode,
}) => {
  const brandColor =
    selectedSession?.source === "claude-code"
      ? CLAUDE_CODE_BRAND_COLOR
      : CODEX_BRAND_COLOR;

  return (
    <Box marginTop={1}>
      <Text color={selectedSession ? brandColor : KEY_COLOR}>⏎ </Text>
      <Text>{yoloMode ? "resume in yolo mode" : "resume"}</Text>
      <Text color={HEADER_COLOR}> │ </Text>
      <Text color={KEY_COLOR}>⇥ </Text>
      <Text>toggle yolo mode</Text>
    </Box>
  );
};

function formatPath(cwd: string, homeDir: string): string {
  if (!cwd) {
    return ".";
  }

  const normalized = path.resolve(cwd);
  if (homeDir && normalized.startsWith(homeDir)) {
    const relative = path.relative(homeDir, normalized) || ".";
    return `~/${relative}`.replace(/\\/g, "/");
  }

  return normalized;
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength === 1) {
    return "…";
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function pad(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (value.length >= width) {
    return value;
  }
  return value.padEnd(width, " ");
}

function formatModelLabel(session: SessionSummary): string {
  if (session.source === "claude-code") {
    const formattedModel = formatClaudeCodeModel(session.model);
    return `Claude Code (${formattedModel})`;
  }
  const modelName = session.model ?? "unknown";
  return `Codex (${modelName})`;
}

function formatClaudeCodeModel(model: string | null | undefined): string {
  if (typeof model !== "string" || model.trim().length === 0) {
    return "unknown";
  }
  const trimmed = model.trim();
  const withoutProvider = trimmed.replace(/^[^/]+\//, "");
  const match = withoutProvider.match(/claude[-_](.+)/i);
  if (match && match[1]) {
    const candidate = match[1].trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }
  return withoutProvider.length > 0 ? withoutProvider : trimmed;
}

function formatSiSuffix(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return "0";
  }
  if (n < 1000) {
    return n.toLocaleString();
  }

  const units: Array<{ scale: number; suffix: string }> = [
    { scale: 1_000, suffix: "K" },
    { scale: 1_000_000, suffix: "M" },
    { scale: 1_000_000_000, suffix: "G" },
  ];

  for (const { scale, suffix } of units) {
    const ratio = n / scale;
    if (ratio < 1) {
      continue;
    }
    if (ratio < 10) {
      return `${formatFixed(ratio, 2)}${suffix}`;
    }
    if (ratio < 100) {
      return `${formatFixed(ratio, 1)}${suffix}`;
    }
    if (ratio < 1000) {
      return `${Math.round(ratio).toLocaleString()}${suffix}`;
    }
  }

  const giga = n / 1_000_000_000;
  return `${Math.round(giga).toLocaleString()}G`;
}

function formatFixed(value: number, fractionDigits: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function clampOffset(value: number, maxOffset: number): number {
  if (maxOffset <= 0) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > maxOffset) {
    return maxOffset;
  }
  return value;
}

interface SparklineMetrics {
  points: number[];
  totalTokens: number;
  peakDay: string | null;
  dayCount: number;
  hasActivity: boolean;
}

interface ChartMetrics {
  sparkline: SparklineMetrics;
  providerBars: BarChartData[];
  footprint: number;
}

function computeChartMetrics(
  sessions: SessionSummary[],
  columns: number
): ChartMetrics {
  const dayCount = Math.max(1, columns);
  const sparkline = computeSparklineSeries(sessions, dayCount);
  const providerBars = computeProviderBars(sessions);

  let footprint = 0;
  if (sparkline.hasActivity) {
    footprint += 2; // label + sparkline
  }
  if (providerBars.length > 0) {
    footprint += 1 + providerBars.length; // label + each bar row
  }

  return {
    sparkline,
    providerBars,
    footprint,
  };
}

function computeSparklineSeries(
  sessions: SessionSummary[],
  dayCount: number
): SparklineMetrics {
  if (dayCount <= 0) {
    return {
      points: [],
      totalTokens: 0,
      peakDay: null,
      dayCount: 0,
      hasActivity: false,
    };
  }

  const today = startOfDay(new Date());
  const labels: Date[] = [];
  const points: number[] = [];
  const keyToIndex = new Map<string, number>();

  for (let i = dayCount - 1; i >= 0; i -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    labels.push(day);
    points.push(0);
    keyToIndex.set(formatDateKey(day), labels.length - 1);
  }

  for (const session of sessions) {
    const key = formatDateKey(session.timestamp);
    const index = keyToIndex.get(key);
    if (typeof index === "number") {
      points[index] += session.blendedTokens;
    }
  }

  let maxTokens = 0;
  let maxIndex = -1;
  for (let i = 0; i < points.length; i += 1) {
    const value = points[i];
    if (value > maxTokens) {
      maxTokens = value;
      maxIndex = i;
    }
  }

  const totalTokens = points.reduce((acc, value) => acc + value, 0);
  const peakDay =
    maxTokens > 0 && maxIndex >= 0 ? formatDayLabel(labels[maxIndex]) : null;
  const hasActivity = maxTokens > 0;

  return { points, totalTokens, peakDay, dayCount, hasActivity };
}

function computeProviderBars(sessions: SessionSummary[]): BarChartData[] {
  const buckets: Record<
    SessionSummary["source"],
    {
      label: string;
      tokens: number;
      messages: number;
      color: string;
    }
  > = {
    codex: {
      label: "Codex",
      tokens: 0,
      messages: 0,
      color: CODEX_BRAND_COLOR,
    },
    "claude-code": {
      label: "Claude Code",
      tokens: 0,
      messages: 0,
      color: CLAUDE_CODE_BRAND_COLOR,
    },
  };

  for (const session of sessions) {
    const bucket = buckets[session.source];
    if (!bucket) {
      continue;
    }
    bucket.tokens += session.blendedTokens;
    bucket.messages += Math.max(0, session.messageCount ?? 0);
  }

  const data: BarChartData[] = [];
  for (const bucket of Object.values(buckets)) {
    if (bucket.tokens <= 0 && bucket.messages <= 0) {
      continue;
    }
    data.push({
      label: bucket.label,
      value: bucket.tokens,
      color: bucket.color,
    });
  }

  return data;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDayLabel(date: Date): string {
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${weekday} ${month}/${day}`;
}

export default SessionPicker;
