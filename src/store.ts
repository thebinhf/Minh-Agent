export interface Task {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
}

/**
 * In-memory task store. Intentionally simple: this project exists to
 * demonstrate a working end-to-end development environment, not to persist
 * data across restarts.
 */
export class TaskStore {
  private tasks = new Map<string, Task>();

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  create(title: string): Task {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("title is required");
    }
    const task: Task = {
      id: globalThis.crypto.randomUUID(),
      title: trimmed,
      done: false,
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  toggle(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    task.done = !task.done;
    return task;
  }

  remove(id: string): boolean {
    return this.tasks.delete(id);
  }

  clear(): void {
    this.tasks.clear();
  }
}
