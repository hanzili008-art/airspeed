const ENDPOINTS = {
  download: "https://speed.cloudflare.com/__down",
  upload: "https://speed.cloudflare.com/__up",
};

const PROFILES = {
  standard: {
    durationMs: 6_000,
    concurrency: 4,
    downloadChunkBytes: 25_000_000,
    uploadChunkBytes: 10_000_000,
    maxDownloadBytes: 500_000_000,
    maxUploadBytes: 250_000_000,
    downloadWarmupBytes: 8_000_000,
    uploadWarmupBytes: 2_000_000,
    note: "最多使用约 760 MB 流量，高速网络会使用更多流量",
  },
  lite: {
    durationMs: 2_500,
    concurrency: 2,
    downloadChunkBytes: 2_000_000,
    uploadChunkBytes: 1_000_000,
    maxDownloadBytes: 8_000_000,
    maxUploadBytes: 4_000_000,
    downloadWarmupBytes: 500_000,
    uploadWarmupBytes: 250_000,
    note: "最多使用约 13 MB 流量，结果更适合日常参考",
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
  downloadPeak: document.querySelector("#downloadPeak"),
  uploadPeak: document.querySelector("#uploadPeak"),
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

function formatSpeed(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 100) return Math.round(value).toString();
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function speedToProgress(speed) {
  if (speed <= 0) return 0;
  const normalized = Math.log10(speed + 1) / Math.log10(1001);
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
  ui.downloadPeak.textContent = "峰值 --";
  ui.uploadPeak.textContent = "峰值 --";
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

function throwIfAborted(signal) {
  if (signal.aborted) throw new DOMException("测试已停止", "AbortError");
}

async function testLatency(signal) {
  const samples = [];
  ui.phaseLabel.textContent = "正在测试延迟";
  ui.helperText.textContent = "连接最近的测速节点";
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

async function warmUpDownload(bytes, signal) {
  ui.phaseLabel.textContent = "正在预热下载连接";
  ui.helperText.textContent = "为高速线路建立稳定连接";
  const response = await fetch(cacheBustedUrl(ENDPOINTS.download, { bytes }), {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`下载预热失败 (${response.status})`);
  await response.arrayBuffer();
}

function uploadRequest(bytes, signal, onProgress) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("测试已停止", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();
    const payload = new Uint8Array(bytes);
    let reportedBytes = 0;

    xhr.open("POST", cacheBustedUrl(ENDPOINTS.upload));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      const delta = event.loaded - reportedBytes;
      reportedBytes = event.loaded;
      if (delta > 0) onProgress(delta);
    };

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`上传测试失败 (${xhr.status})`));
        return;
      }
      const remaining = bytes - reportedBytes;
      if (remaining > 0) onProgress(remaining);
      resolve();
    };
    xhr.onerror = () => reject(new Error("上传测试连接失败"));
    xhr.onabort = () => reject(new DOMException("测试已停止", "AbortError"));

    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.addEventListener("loadend", () => signal.removeEventListener("abort", abort), { once: true });
    xhr.send(payload);
  });
}

async function warmUpUpload(bytes, signal) {
  ui.phaseLabel.textContent = "正在预热上传连接";
  ui.helperText.textContent = "为高速线路建立稳定连接";
  await uploadRequest(bytes, signal, () => {});
}

function createMeasurementTracker(onUpdate) {
  const startedAt = performance.now();
  const checkpoints = [{ time: startedAt, bytes: 0 }];
  let totalBytes = 0;
  let peakMbps = 0;
  let lastCheckpointAt = startedAt;

  function addBytes(bytes) {
    totalBytes += bytes;
    const now = performance.now();
    if (now - lastCheckpointAt < 100) return;

    const checkpoint = { time: now, bytes: totalBytes };
    checkpoints.push(checkpoint);
    lastCheckpointAt = now;

    const windowStart = now - 1_200;
    const baseline = checkpoints.find((item) => item.time >= windowStart) ?? checkpoints[0];
    const elapsedSeconds = (now - baseline.time) / 1000;
    if (elapsedSeconds <= 0) return;

    const liveMbps = ((totalBytes - baseline.bytes) * 8) / elapsedSeconds / 1_000_000;
    if (now - startedAt > 700) peakMbps = Math.max(peakMbps, liveMbps);
    onUpdate(liveMbps, peakMbps, totalBytes);
  }

  function finish() {
    const endedAt = performance.now();
    checkpoints.push({ time: endedAt, bytes: totalBytes });
    const elapsedMs = endedAt - startedAt;
    const stableStartAt = startedAt + Math.min(1_000, elapsedMs * 0.2);
    const stableBaseline = [...checkpoints]
      .reverse()
      .find((item) => item.time <= stableStartAt) ?? checkpoints[0];
    const stableSeconds = (endedAt - stableBaseline.time) / 1000;
    const stableMbps = stableSeconds > 0
      ? ((totalBytes - stableBaseline.bytes) * 8) / stableSeconds / 1_000_000
      : 0;

    return {
      stable: stableMbps,
      peak: Math.max(peakMbps, stableMbps),
      bytes: totalBytes,
      elapsedMs,
    };
  }

  return { addBytes, finish, getTotalBytes: () => totalBytes };
}

function createRunController(parentSignal, durationMs) {
  const controller = new AbortController();
  let endedByLimit = false;
  const abortFromParent = () => controller.abort();
  parentSignal.addEventListener("abort", abortFromParent, { once: true });
  if (parentSignal.aborted) controller.abort();

  const timer = setTimeout(() => {
    endedByLimit = true;
    controller.abort();
  }, durationMs);

  return {
    signal: controller.signal,
    stopAtLimit() {
      endedByLimit = true;
      controller.abort();
    },
    endedByLimit: () => endedByLimit,
    cleanup() {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}

async function runDownloadMeasurement(profile, parentSignal) {
  ui.phaseLabel.textContent = "正在测试下载速度";
  ui.helperText.textContent = "使用多个数据流测量稳定速度";
  ui.speedUnit.textContent = "Mbps";

  const run = createRunController(parentSignal, profile.durationMs);
  const tracker = createMeasurementTracker((live, peak, totalBytes) => {
    setMeter(live);
    ui.downloadValue.textContent = formatSpeed(live);
    ui.downloadPeak.textContent = `峰值 ${formatSpeed(peak)}`;
    if (totalBytes >= profile.maxDownloadBytes) run.stopAtLimit();
  });

  async function worker() {
    while (!run.signal.aborted && tracker.getTotalBytes() < profile.maxDownloadBytes) {
      try {
        const response = await fetch(cacheBustedUrl(ENDPOINTS.download, {
          bytes: profile.downloadChunkBytes,
        }), {
          cache: "no-store",
          signal: run.signal,
        });
        if (!response.ok) throw new Error(`下载测试失败 (${response.status})`);

        if (response.body?.getReader) {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            tracker.addBytes(value.byteLength);
          }
        } else {
          tracker.addBytes((await response.arrayBuffer()).byteLength);
        }
      } catch (error) {
        if (run.signal.aborted && !parentSignal.aborted) break;
        throw error;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: profile.concurrency }, () => worker()));
  } finally {
    run.cleanup();
  }
  throwIfAborted(parentSignal);

  const result = tracker.finish();
  ui.downloadValue.textContent = formatSpeed(result.stable);
  ui.downloadPeak.textContent = `峰值 ${formatSpeed(result.peak)}`;
  setMeter(result.stable);
  return result;
}

async function runUploadMeasurement(profile, parentSignal) {
  ui.phaseLabel.textContent = "正在测试上传速度";
  ui.helperText.textContent = "使用多个数据流测量稳定速度";

  const run = createRunController(parentSignal, profile.durationMs);
  const tracker = createMeasurementTracker((live, peak, totalBytes) => {
    setMeter(live);
    ui.uploadValue.textContent = formatSpeed(live);
    ui.uploadPeak.textContent = `峰值 ${formatSpeed(peak)}`;
    if (totalBytes >= profile.maxUploadBytes) run.stopAtLimit();
  });

  async function worker() {
    while (!run.signal.aborted && tracker.getTotalBytes() < profile.maxUploadBytes) {
      try {
        await uploadRequest(profile.uploadChunkBytes, run.signal, tracker.addBytes);
      } catch (error) {
        if (run.signal.aborted && !parentSignal.aborted) break;
        throw error;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: profile.concurrency }, () => worker()));
  } finally {
    run.cleanup();
  }
  throwIfAborted(parentSignal);

  const result = tracker.finish();
  ui.uploadValue.textContent = formatSpeed(result.stable);
  ui.uploadPeak.textContent = `峰值 ${formatSpeed(result.peak)}`;
  setMeter(result.stable);
  return result;
}

function estimateBroadband(downloadSpeed) {
  const tiers = [10, 20, 50, 100, 200, 300, 500, 1000, 2000, 2500];
  const thresholds = [15, 35, 75, 150, 250, 400, 750, 1500, 2250];
  const index = thresholds.findIndex((threshold) => downloadSpeed < threshold);
  return index === -1 ? tiers.at(-1) : tiers[index];
}

function describeResult({ latency, download, upload }) {
  let title = "你的网络表现出色。";
  if (download.stable < 25 || upload.stable < 5 || latency > 80) title = "日常使用基本够用。";
  if (download.stable < 8 || upload.stable < 2 || latency > 150) title = "网络还有提升空间。";

  const tasks = [];
  if (download.stable >= 80) tasks.push("4K 视频");
  else if (download.stable >= 20) tasks.push("高清视频");
  else tasks.push("网页浏览");

  if (upload.stable >= 15) tasks.push("大型文件上传");
  else if (upload.stable >= 5) tasks.push("视频通话");

  const broadbandTier = estimateBroadband(download.stable);
  ui.broadbandValue.textContent = `约 ${broadbandTier}M 宽带`;
  ui.broadbandEstimate.hidden = false;
  ui.resultTitle.textContent = title;
  ui.resultCopy.textContent = `当前连接相当于约 ${broadbandTier}M 宽带，适合${tasks.join("和")}。空闲延迟约 ${Math.round(latency)} ms；下载稳定 ${formatSpeed(download.stable)} Mbps，峰值 ${formatSpeed(download.peak)} Mbps；上传稳定 ${formatSpeed(upload.stable)} Mbps，峰值 ${formatSpeed(upload.peak)} Mbps。`;
}

async function runTest() {
  if (running) {
    abortController?.abort();
    return;
  }

  resetResults();
  setRunningState(true);
  setStatus("测试进行中", "running");
  abortController = new AbortController();
  const profile = PROFILES[selectedMode];

  try {
    const latency = await testLatency(abortController.signal);
    await warmUpDownload(profile.downloadWarmupBytes, abortController.signal);
    const download = await runDownloadMeasurement(profile, abortController.signal);
    await warmUpUpload(profile.uploadWarmupBytes, abortController.signal);
    const upload = await runUploadMeasurement(profile, abortController.signal);

    describeResult({ latency, download, upload });
    ui.phaseLabel.textContent = "测试完成";
    ui.helperText.textContent = "稳定速度用于宽带估算，峰值反映瞬时上限。";
    setMeter(download.stable);
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

