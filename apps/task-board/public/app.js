const tasksEl = document.getElementById("tasks");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
const formEl = document.getElementById("new-task");
const titleEl = document.getElementById("title");

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

function render(tasks) {
  tasksEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", tasks.length > 0);

  for (const task of tasks) {
    const li = document.createElement("li");
    li.className = `task ${task.done ? "done" : ""}`.trim();

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.done;
    checkbox.addEventListener("change", () => toggleTask(task.id));

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = task.title;

    const del = document.createElement("button");
    del.className = "icon-btn";
    del.setAttribute("aria-label", `Delete ${task.title}`);
    del.textContent = "✕";
    del.addEventListener("click", () => deleteTask(task.id));

    li.append(checkbox, title, del);
    tasksEl.append(li);
  }
}

async function refresh() {
  try {
    const tasks = await api("/api/tasks");
    render(tasks);
    setStatus("connected", "ok");
  } catch (err) {
    setStatus(`error: ${err.message}`, "error");
  }
}

async function toggleTask(id) {
  await api(`/api/tasks/${id}`, { method: "PATCH" });
  await refresh();
}

async function deleteTask(id) {
  await api(`/api/tasks/${id}`, { method: "DELETE" });
  await refresh();
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = titleEl.value.trim();
  if (!title) return;
  await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  titleEl.value = "";
  titleEl.focus();
  await refresh();
});

refresh();
