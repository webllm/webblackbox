const refs = {
  taskInput: document.getElementById("task-input"),
  addTask: document.getElementById("add-task"),
  taskList: document.getElementById("task-list"),
  loadDashboard: document.getElementById("load-dashboard"),
  loadSlow: document.getElementById("load-slow"),
  loadFail: document.getElementById("load-fail"),
  savePrefs: document.getElementById("save-prefs"),
  pulseDom: document.getElementById("pulse-dom"),
  pulseTarget: document.getElementById("pulse-target"),
  networkOutput: document.getElementById("network-output"),
  eventLog: document.getElementById("event-log")
};

const state = {
  tasks: [],
  pulseCount: 0,
  eventCount: 0
};

function nowIso() {
  return new Date().toISOString();
}

function appendLog(kind, payload = undefined) {
  state.eventCount += 1;
  const row = document.createElement("li");
  const stamp = nowIso();
  const details = payload === undefined ? "" : ` | ${JSON.stringify(payload)}`;
  row.textContent = `[${state.eventCount}] ${stamp} ${kind}${details}`;
  refs.eventLog.prepend(row);

  while (refs.eventLog.children.length > 60) {
    refs.eventLog.removeChild(refs.eventLog.lastElementChild);
  }
}

function setOutput(label, payload) {
  refs.networkOutput.textContent = `${label}\n${JSON.stringify(payload, null, 2)}`;
}

function renderTasks() {
  refs.taskList.innerHTML = state.tasks
    .map((task) => `<li data-task-id="${task.id}">${task.id}: ${escapeHtml(task.title)}</li>`)
    .join("");
}

async function requestJson(label, url, init = undefined) {
  const started = performance.now();

  try {
    const response = await fetch(url, init);
    const elapsedMs = Number((performance.now() - started).toFixed(2));
    const text = await response.text();
    const body = text.length > 0 ? JSON.parse(text) : null;
    const result = {
      ok: response.ok,
      status: response.status,
      elapsedMs,
      body
    };

    setOutput(label, result);
    appendLog(`request.${label}`, {
      status: response.status,
      elapsedMs,
      ok: response.ok
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`request.${label}.error`, { message });
    setOutput(label, {
      ok: false,
      error: message
    });
    return {
      ok: false,
      error: message
    };
  }
}

async function addTaskFromInput() {
  const raw = refs.taskInput.value.trim();
  const title = raw.length > 0 ? raw : `Task ${state.tasks.length + 1}`;

  refs.taskInput.value = title;

  const response = await requestJson("add-task", "/api/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      title,
      source: "demo-ui"
    })
  });

  const task = response?.body?.task;

  if (response.ok && task && typeof task.id === "string") {
    state.tasks.push(task);
    renderTasks();
  }

  refs.taskInput.value = "";
}

async function loadDashboard() {
  await requestJson("dashboard", "/api/dashboard?view=interactive");
}

async function loadSlowReport() {
  await requestJson("slow-report", "/api/slow-report?delay=700");
}

async function loadFailure() {
  await requestJson("failure", "/api/fail?code=503");
}

function savePreferences() {
  const prefs = {
    theme: "mint",
    density: "comfortable",
    updatedAt: nowIso(),
    totalTasks: state.tasks.length
  };

  localStorage.setItem("wb.demo.prefs", JSON.stringify(prefs));
  sessionStorage.setItem("wb.demo.last-action", "save-prefs");
  document.cookie = `wbDemoLastSave=${encodeURIComponent(prefs.updatedAt)}; path=/`;
  appendLog("storage.saved", prefs);
}

function pulseDom() {
  state.pulseCount += 1;
  refs.pulseTarget.textContent = `Pulse count: ${state.pulseCount}`;
  refs.pulseTarget.classList.remove("pulse");

  requestAnimationFrame(() => {
    refs.pulseTarget.classList.add("pulse");
  });

  appendLog("dom.pulse", { pulseCount: state.pulseCount });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runScenario(options = {}) {
  const title =
    typeof options.taskTitle === "string" && options.taskTitle.trim().length > 0
      ? options.taskTitle.trim()
      : `E2E task ${Date.now()}`;

  refs.taskInput.value = title;
  appendLog("scenario.start", { title });

  await addTaskFromInput();
  await loadDashboard();
  await loadSlowReport();
  await loadFailure();
  savePreferences();
  pulseDom();
  await sleep(120);

  appendLog("scenario.complete", {
    tasks: state.tasks.length,
    pulseCount: state.pulseCount
  });

  return {
    ok: true,
    tasks: state.tasks.length,
    pulseCount: state.pulseCount,
    latestOutput: refs.networkOutput.textContent
  };
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

refs.addTask.addEventListener("click", () => {
  void addTaskFromInput();
});

refs.taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addTaskFromInput();
  }
});

refs.loadDashboard.addEventListener("click", () => {
  void loadDashboard();
});

refs.loadSlow.addEventListener("click", () => {
  void loadSlowReport();
});

refs.loadFail.addEventListener("click", () => {
  void loadFailure();
});

refs.savePrefs.addEventListener("click", () => {
  savePreferences();
});

refs.pulseDom.addEventListener("click", () => {
  pulseDom();
});

window.__wbDemo = {
  runScenario,
  snapshot() {
    return {
      tasks: state.tasks.length,
      pulseCount: state.pulseCount,
      events: state.eventCount
    };
  }
};

appendLog("demo.ready", { href: location.href });
