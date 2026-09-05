import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { TaskStore } from "../src/store.js";

describe("Minh-Agent task API", () => {
  let app: ReturnType<typeof createApp>;
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
    app = createApp(store);
  });

  it("reports health", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("starts with no tasks", async () => {
    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("creates, toggles, lists, and deletes a task end-to-end", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .send({ title: "Ship the environment" });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe("Ship the environment");
    expect(created.body.done).toBe(false);
    const id = created.body.id as string;

    const listed = await request(app).get("/api/tasks");
    expect(listed.body).toHaveLength(1);

    const toggled = await request(app).patch(`/api/tasks/${id}`);
    expect(toggled.status).toBe(200);
    expect(toggled.body.done).toBe(true);

    const deleted = await request(app).delete(`/api/tasks/${id}`);
    expect(deleted.status).toBe(204);

    const empty = await request(app).get("/api/tasks");
    expect(empty.body).toEqual([]);
  });

  it("rejects a blank title", async () => {
    const res = await request(app).post("/api/tasks").send({ title: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 404 when toggling a missing task", async () => {
    const res = await request(app).patch("/api/tasks/does-not-exist");
    expect(res.status).toBe(404);
  });
});
