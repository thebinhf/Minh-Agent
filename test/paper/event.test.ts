import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { parsePaperArgs } from "../../src/paper/cli";
import { paperEvent } from "../../src/paper/event";
import { paperWeek } from "../../src/paper/ops";
import { mockFeed, paperEngine } from "./helpers";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("paper event + week", () => {
  test("CLI parses event and week", () => {
    expect(parsePaperArgs(["event"])).toEqual({ name: "event" });
    expect(parsePaperArgs(["week"])).toEqual({ name: "week" });
  });

  test("event is OCO desk; week is 7-day metrics + standing zones", async () => {
    const ctx = await paperEngine(mockFeed());
    dirs.push(ctx.dir);
    const event = paperEvent(ctx.engine);
    expect(event.mode).toBe("event");
    expect(event.note).toContain("do not poll /confirm");
    expect(event.pending).toEqual([]);
    expect(event.zones).toEqual([]);

    const week = paperWeek(ctx.engine);
    expect(week.week).toBe(true);
    expect(week.days).toBe(7);
    expect(week.metrics.funnel.accepted).toBe(0);
    expect(week.review.families).toEqual([]);
    expect(week.standing).toEqual([]);
  });
});
