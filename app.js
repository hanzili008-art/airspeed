const ENDPOINTS = {
  download: "https://speed.cloudflare.com/__down",
  upload: "https://speed.cloudflare.com/__up",
};

const PROFILES = {
  standard: {
    downloadSizes: [2_000_000, 5_000_000, 10_000_000, 20_000_000],
    uploadSizes: [1_000_000, 3_000_000, 5_000_000],
    note: "预计使用约 45 MB 流量",
  },
  lite: {
    downloadSizes: [500_000, 1_000_000, 2_000_000],
    uploadSizes: [500_000, 1_000_000],
    note: "预计使用约 5 MB 流量",
  },
};

const ui = {
  startButton: document.querySelector("#startButton"),
  retestButton: document.querySelector("#retestButton"),
  buttonIcon: document.querySelector("#buttonIcon"),
  buttonLabel: document.querySelector("#buttonLabel"),
  speedValue: document.querySelector("#speedValue"),
  speedUnit: document.querySelector("#speedUnit"),
  latencyValue: document.querySelector("#latencyValue"),
  downloadValue: document.querySelector("#downloadValue"),
  uploadValue: document.querySelector("#uploadValue"),
  ringProgress: document.querySelector("#ringProgress"),
  meterNeedle: document.querySelector("#meterNeedle"),
  phaseLabel: document.querySelector("#phaseLabel"),
  helperText: document.querySelector("#helperText"),
  connectionDot: document.querySelector("#connectionDot"),
  connectionLabel: document.querySelector("#connectionLabel"),
  resultBand: document.querySelector("#resultBand"),
  resultTitle: document.querySelector("#resultTitle"),
  resultCopy: document.querySelector("#resultCopy"),
  broadbandEstimate: document.querySelector("#broadbandEstimate"),
  broadbandValue: document.querySelector("#broadbandValue"),
  dataNote: document.querySelector("#dataNote"),
  modeButtons: [...document.querySelectorAll(".mode-button")],
};

let selectedMode = "standard";
let running = false;
let abortController = null;
let activeRequest = null;

function formatSpeed(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 100) return Math.round(value).toString();
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function speedToProgress(speed) {
  if (speed <= 0) return 0;
  const normalized = Math.log10(speed + 1) / Math.log10(501);
  return Math.min(100, normalized * 100);
}

function setMeter(value, unit = "Mbps") {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const progress = unit === "ms"
    ? Math.min(100, safeValue / 2)
    : speedToProgress(safeValue);

  ui.speedValue.textContent = unit === "ms"
    ? Math.round(safeValue).toString()
    : formatSpeed(safeValue);
  ui.speedUnit.textContent = unit;
  ui.ringProgress.style.strokeDashoffset = String(100 - progress);
  ui.meterNeedle.style.transform = `rotate(${progress * 1.8}deg)`;
}

function setStatus(label, state = "idle") {
  ui.connectionLabel.textContent = label;
  ui.connectionDot.className = `status-dot${state === "idle" ? "" : ` ${state}`}`;
}

function setRunningState(isRunning) {
  running = isRunning;
  ui.startButton.classList.toggle("running", isRunning);
  ui.buttonIcon.textContent = isRunning ? "×" : "→";
  ui.buttonLabel.textContent = isRunning ? "停止测试" : "开始测速";
  ui.modeButtons.forEach((button) => {
    button.disabled = isRunning;
  });
}

function resetResults() {
  ui.latencyValue.textContent = "--";
  ui.downloadValue.textContent = "--";
  ui.uploadValue.textContent = "--";
  ui.broadbandEstimate.hidden = true;
  ui.resultBand.hidden = true;
  setMeter(0);
}

function cacheBustedUrl(endpoint, params = {}) {
  const url = new URL(endpoint);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("t", `${Date.now()}-${Math.random()}`);
  return url.toString();
}

async function testLatency(signal) {
  const samples = [];
  ui.phaseLabel.textContent = "正在测试延迟";
  ui.helperText.textContent = "连接最近的测速节点…";
  ui.speedUnit.textContent = "ms";

  for (let index = 0; index < 7; index += 1) {
    const started = performance.now();
    const response = await fetch(cacheBustedUrl(ENDPOINTS.download, { bytes: 0 }), {
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error(`延迟测试失败 (${response.status})`);
    await response.arrayBuffer();
    const elapsed = performance.now() - started;

    if (index > 0) samples.push(elapsed);
    setMeter(elapsed, "ms");
    ui.latencyValue.textContent = Math.round(elapsed).toString();
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  samples.sort((a, b) => a - b);
  const latency = samples[Math.floor(samples.length / 2)];
  ui.latencyValue.textContent = Math.round(latency).toString();
  return latency;
}

async function downloadSample(bytes, signal) {
  const started = performance.now();
  const response = await fetch(cacheBustedUrl(ENDPOINTS.download, { bytes }), {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`下载测试失败 (${response.status})`);

  let received = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      const elapsed = (performance.now() - started) / 1000;
      if (elapsed > 0.12) setMeter((received * 8) / elapsed / 1_000_000);
    }
  } else {
    received = (await response.arrayBuffer()).byteLength;
  }

  const elapsed = (performance.now() - started) / 1000;
  return (received * 8) / elapsed / 1_000_000;
}

async function testDownload(sizes, signal) {
  const samples = [];
  ui.phaseLabel.textContent = "正在测试下载速度";
  ui.helperText.textContent = "接收测试数据并实时计算速度…";
  ui.speedUnit.textContent = "Mbps";

  for (const bytes of sizes) {
    const speed = await downloadSample(bytes, signal);
    samples.push(speed);
    ui.downloadValue.textContent = formatSpeed(speed);
    setMeter(speed);

    if (samples.length >= 2 && speed * 1.6 < samples.at(-2)) break;
  }

  const bestSamples = [...samples].sort((a, b) => b - a).slice(0, 2);
  const speed = bestSamples.reduce((sum, value) => sum + value, 0) / bestSamples.length;
  ui.downloadValue.textContent = formatSpeed(speed);
  return speed;
}

function uploadSample(bytes, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeRequest = xhr;
    const payload = new Uint8Array(bytes);
    const started = performance.now();

    xhr.open("POST", cacheBustedUrl(ENDPOINTS.upload));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      const elapsed = (performance.now() - started) / 1000;
      if (elapsed > 0.12) setMeter((event.loaded * 8) / elapsed / 1_000_000);
    };

    xhr.onload = () => {
      activeRequest = null;
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`上传测试失败 (${xhr.status})`));
        return;
      }
      const elapsed = (performance.now() - started) / 1000;
      resolve((bytes * 8) / elapsed / 1_000_000);
    };

    xhr.onerror = () => {
      activeRequest = null;
      reject(new Error("上传测试连接失败"));
    };
    xhr.onabort = () => reject(new DOMException("测试已停止", "AbortError"));

    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(payload);
  });
}

async function testUpload(sizes, signal) {
  const samples = [];
  ui.phaseLabel.textContent = "正在测试上传速度";
  ui.helperText.textContent = "发送测试数据并实时计算速度…";

  for (const bytes of sizes) {
    const speed = await uploadSample(bytes, signal);
    samples.push(speed);
    ui.uploadValue.textContent = formatSpeed(speed);
    setMeter(speed);
  }

  const bestSamples = [...samples].sort((a, b) => b - a).slice(0, 2);
  const speed = bestSamples.reduce((sum, value) => sum + value, 0) / bestSamples.length;
  ui.uploadValue.textContent = formatSpeed(speed);
  return speed;
}

function estimateBroadband(downloadSpeed) {
  const tiers = [10, 20, 50, 100, 200, 300, 500, 1000];
  const thresholds = [15, 35, 75, 150, 250, 400, 750];
  const index = thresholds.findIndex((threshold) => downloadSpeed < threshold);
  return index === -1 ? tiers.at(-1) : tiers[index];
}

function describeResult({ latency, download, upload }) {
  let title = "你的网络表现出色。";
  if (download < 25 || upload < 5 || latency > 80) title = "日常使用基本够用。";
  if (download < 8 || upload < 2 || latency > 150) title = "网络还有提升空间。";

  const tasks = [];
  if (download >= 80) tasks.push("4K 视频");
  else if (download >= 20) tasks.push("高清视频");
  else tasks.push("网页浏览");

  if (upload >= 15) tasks.push("大型文件上传");
  else if (upload >= 5) tasks.push("视频通话");

  const broadbandTier = estimateBroadband(download);
  ui.broadbandValue.textContent = `约 ${broadbandTier}M 宽带`;
  ui.broadbandEstimate.hidden = false;
  ui.resultTitle.textContent = title;
  ui.resultCopy.textContent = `当前连接相当于约 ${broadbandTier}M 宽带，适合${tasks.join("和")}。空闲延迟约 ${Math.round(latency)} ms，下载 ${formatSpeed(download)} Mbps，上传 ${formatSpeed(upload)} Mbps。`;
}

async function runTest() {
  if (running) {
    abortController?.abort();
    activeRequest?.abort();
    return;
  }

  resetResults();
  setRunningState(true);
  setStatus("测试进行中", "running");
  abortController = new AbortController();
  const profile = PROFILES[selectedMode];

  try {
    const latency = await testLatency(abortController.signal);
    const download = await testDownload(profile.downloadSizes, abortController.signal);
    const upload = await testUpload(profile.uploadSizes, abortController.signal);

    describeResult({ latency, download, upload });
    ui.phaseLabel.textContent = "测试完成";
    ui.helperText.textContent = "这是你此刻的网络表现。";
    setMeter(download);
    setStatus("测试完成");
    ui.resultBand.hidden = false;
    setTimeout(() => ui.resultBand.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  } catch (error) {
    if (error.name === "AbortError") {
      ui.phaseLabel.textContent = "测试已停止";
      ui.helperText.textContent = "你可以随时重新开始。";
      setStatus("测试已停止");
    } else {
      console.error(error);
      ui.phaseLabel.textContent = "无法完成测试";
      ui.helperText.textContent = "请检查网络连接、代理或浏览器跨域限制后重试。";
      setStatus("连接失败", "error");
    }
  } finally {
    setRunningState(false);
    abortController = null;
    activeRequest = null;
  }
}

ui.startButton.addEventListener("click", runTest);
ui.retestButton.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
  setTimeout(runTest, 350);
});

ui.modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectedMode = button.dataset.mode;
    ui.modeButtons.forEach((item) => item.classList.toggle("active", item === button));
    ui.dataNote.textContent = PROFILES[selectedMode].note;
  });
});

if (!navigator.onLine) {
  setStatus("当前离线", "error");
  ui.helperText.textContent = "连接到网络后再开始测试。";
}

window.addEventListener("online", () => setStatus("等待测试"));
window.addEventListener("offline", () => setStatus("当前离线", "error"));

