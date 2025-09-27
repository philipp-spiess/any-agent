import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import os from "node:os";
import path from "node:path";
import type { SessionSummary } from "../codex";
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
  onResume?: (session: SessionSummary) => void;
}

export const SessionPicker: React.FC<SessionPickerProps> = ({
  sessions,
  totalTokens,
  totalCost,
  onResume,
}) => {
  const { exit } = useApp();
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [stdoutColumns, stdoutRows] = useTerminalDimensions();
  const columns = stdoutColumns ?? 80;
  const rows = stdoutRows ?? 24;
  const layout = useMemo(() => computeLayout(columns), [columns]);

  const homeDir = useMemo(() => os.homedir(), []);
  const hasSessions = sessions.length > 0;
  const availableHeight = Math.max(
    rows - HEADER_FOOTPRINT - STATUS_LINE_FOOTPRINT,
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
    } else if (key.return) {
      const session = sessions[highlightedIndex];
      if (session) {
        onResume?.(session);
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
      <Text color={MESSAGE_COLOR}>Agent History</Text>
      <Text color={MESSAGE_COLOR}> </Text>
      {hasSessions ? (
        <>
          {visibleSessions.map(({ session, absoluteIndex }) => (
            <SessionRow
              key={session.path}
              session={session}
              isSelected={absoluteIndex === highlightedIndex}
              homeDir={homeDir}
              layout={layout}
            />
          ))}
        </>
      ) : (
        <Box marginTop={1}>
          <Text color={MESSAGE_COLOR}>No Codex sessions found.</Text>
        </Box>
      )}
      <StatusLine totalTokens={totalTokens} totalCost={totalCost} />
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
  const repoPath = formatPath(session.meta?.cwd ?? ".", homeDir);
  const timestamp = pad(
    truncate(session.relativeTime, layout.timeWidth),
    layout.timeWidth
  );
  const modelName = session.model ? session.model : "unknown";
  const modelColumn = layout.showModel
    ? pad(
        truncate(`Codex (${modelName})`, layout.modelWidth),
        layout.modelWidth
      )
    : "";
  const tokensLabel =
    session.blendedTokens > 0
      ? formatSiSuffix(session.blendedTokens)
      : "";
  const tokensColumn = layout.showTokens
    ? pad(truncate(tokensLabel, layout.tokensWidth), layout.tokensWidth)
    : "";
  const repoColumn = layout.showRepo
    ? pad(truncate(repoPath, layout.repoWidth), layout.repoWidth)
    : "";
  const baseMessage = session.preview ?? "(no user message)";
  const marker = session.branchMarker?.trim().length ? session.branchMarker : " ";
  const decoratedMessage = `${marker} ${baseMessage}`;
  const message = truncate(decoratedMessage, layout.messageWidth);
  const indicator = isSelected ? "➤" : " ";

  const leftColumns = [timestamp];
  if (layout.showModel) {
    leftColumns.push(modelColumn);
  }
  if (layout.showTokens) {
    leftColumns.push(tokensColumn);
  }
  if (layout.showRepo) {
    leftColumns.push(repoColumn);
  }

  const leftPart = ` ${leftColumns.join(" │ ")}`;
  const separator = layout.messageWidth > 0 ? " │ " : "";

  return (
    <Box>
      <Text color={isSelected ? KEY_COLOR : HEADER_COLOR}>{indicator}</Text>
      <Text color={HEADER_COLOR}>{`${leftPart}${separator}`}</Text>
      <Text color={isSelected ? KEY_COLOR : MESSAGE_COLOR}>{message}</Text>
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

const KEY_TO_PROP: Record<ColumnKey, keyof Pick<TableLayout, "timeWidth" | "modelWidth" | "tokensWidth" | "repoWidth" | "messageWidth">> = {
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

const StatusLine: React.FC<{ totalTokens: number; totalCost: number }> = ({
  totalTokens,
  totalCost,
}) => (
  <Box marginTop={1}>
    <Text>
      <Text color={KEY_COLOR}>{formatSiSuffix(totalTokens)}</Text>
      <Text> total tokens</Text>
    </Text>
    {totalCost > 0 ? (
      <>
        <Text>  </Text>
        <Text>
          <Text color={KEY_COLOR}>{formatUsd(totalCost)}</Text>
          <Text> total costs</Text>
        </Text>
      </>
    ) : null}
    <Text>  </Text>
    <Text color={KEY_COLOR}>⏎ </Text>
    <Text>resume</Text>
  </Box>
);

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

export default SessionPicker;
