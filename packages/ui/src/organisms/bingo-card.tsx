"use client";

import { useRef, useState, type KeyboardEvent } from "react";

const COLUMN_LABELS = ["B", "I", "N", "G", "O"] as const;

export type BingoCardCell = {
  state: "free" | "uncalled" | "called" | "marked";
  value: number | "FREE";
};

export type BingoCardProps = {
  cells: readonly BingoCardCell[];
  onMark: (ball: number) => void;
  pendingBall?: number | null;
  statusMessage?: string;
  unavailableReason?: string;
};

function cellStatus(cell: BingoCardCell, unavailableReason: string | undefined): string {
  if (cell.state === "free") return "Free";
  if (cell.state === "marked") return "Marked";
  if (unavailableReason !== undefined) return "Locked";
  return cell.state === "called" ? "Called - mark" : "Not called";
}

function cellContext(cell: BingoCardCell, unavailableReason: string | undefined): string {
  if (cell.state === "free") return "automatically satisfied";
  if (cell.state === "marked") return "";
  if (unavailableReason !== undefined) return `unavailable because ${unavailableReason}`;
  return cell.state === "called" ? "available to mark" : "cannot be marked yet";
}

export function BingoCard({
  cells,
  onMark,
  pendingBall = null,
  statusMessage = "",
  unavailableReason,
}: BingoCardProps) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [localFeedback, setLocalFeedback] = useState({ context: "", message: "" });
  const pendingReason = pendingBall === null ? unavailableReason : "mark confirmation is pending";
  const feedbackContext = `${pendingReason ?? "available"}:${cells
    .map((cell) => `${cell.value}:${cell.state}`)
    .join("|")}`;
  const localStatus = localFeedback.context === feedbackContext ? localFeedback.message : "";

  function setLocalStatus(message: string) {
    setLocalFeedback({ context: feedbackContext, message });
  }

  function focusCell(index: number) {
    setActiveIndex(index);
    buttons.current[index]?.focus();
  }

  function handleNavigation(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const rowStart = Math.floor(index / 5) * 5;
    let target: number;
    switch (event.key) {
      case "ArrowLeft":
        target = Math.max(rowStart, index - 1);
        break;
      case "ArrowRight":
        target = Math.min(rowStart + 4, index + 1);
        break;
      case "ArrowUp":
        target = Math.max(index % 5, index - 5);
        break;
      case "ArrowDown":
        target = Math.min(20 + (index % 5), index + 5);
        break;
      case "Home":
        target = event.ctrlKey || event.metaKey ? 0 : rowStart;
        break;
      case "End":
        target = event.ctrlKey || event.metaKey ? 24 : rowStart + 4;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusCell(target);
  }

  function activate(cell: BingoCardCell, index: number) {
    const column = COLUMN_LABELS[index % 5];
    if (cell.state === "free") {
      setLocalStatus(`${column} free space is automatically satisfied.`);
      return;
    }
    if (cell.state === "marked") {
      setLocalStatus(`${column} ${cell.value} is already marked.`);
      return;
    }
    if (pendingBall !== null) return;
    if (pendingReason !== undefined) {
      setLocalStatus(`${column} ${cell.value} is unavailable because ${pendingReason}.`);
      return;
    }
    if (cell.state === "uncalled") {
      setLocalStatus(`${column} ${cell.value} has not been called and was not marked.`);
      return;
    }
    setLocalStatus("");
    if (cell.value !== "FREE") onMark(cell.value);
  }

  return (
    <>
      <div className="bingo-card-scroll">
        <table className="bingo-card">
          <caption>Your Bingo card</caption>
          <thead>
            <tr>
              {COLUMN_LABELS.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }, (_, row) => (
              <tr key={row}>
                {cells.slice(row * 5, row * 5 + 5).map((cell, column) => {
                  const index = row * 5 + column;
                  const disabled = cell.state !== "called" || pendingReason !== undefined;
                  return (
                    <td key={index}>
                      <button
                        aria-disabled={disabled}
                        className="bingo-card-cell"
                        data-state={
                          pendingReason !== undefined &&
                          cell.state !== "free" &&
                          cell.state !== "marked"
                            ? "unavailable"
                            : cell.state
                        }
                        onClick={() => activate(cell, index)}
                        onFocus={() => setActiveIndex(index)}
                        onKeyDown={(event) => handleNavigation(event, index)}
                        ref={(button) => {
                          buttons.current[index] = button;
                        }}
                        tabIndex={activeIndex === index ? 0 : -1}
                        type="button"
                      >
                        <span className="bingo-card-context">{COLUMN_LABELS[column]}:</span>{" "}
                        <span className="bingo-card-value">
                          {cell.value === "FREE" ? "FREE" : cell.value}
                        </span>{" "}
                        <span className="bingo-card-state">{cellStatus(cell, pendingReason)}</span>{" "}
                        <span className="bingo-card-context">
                          {cellContext(cell, pendingReason)}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p
        aria-atomic="true"
        aria-label="Card marking status"
        aria-live="polite"
        className="card-mark-status"
        role="status"
      >
        {localStatus || statusMessage}
      </p>
    </>
  );
}
