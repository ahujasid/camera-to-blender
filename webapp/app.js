// Photo → 3D → Blender Web App

// Use current origin (works for localhost, ngrok, or direct IP)
const API_BASE = window.location.origin;

// DOM elements
const video = document.getElementById('camera');
const canvas = document.getElementById('snapshot');
const preview = document.getElementById('preview');
const placeholder = document.getElementById('placeholder');
const captureBtn = document.getElementById('capture');
const sendBtn = document.getElementById('sendToBlender');
const controlsMain = document.getElementById('controlsMain');
const reviewControls = document.getElementById('reviewControls');
const confirmBtn = document.getElementById('confirmBtn');
const retakeBtn = document.getElementById('retakeBtn');
const startAgainBtn = document.getElementById('startAgainBtn');
const generationControls = document.getElementById('generationControls');
const cancelGenerationBtn = document.getElementById('cancelGenerationBtn');
const generationSegmentsTrack = document.getElementById('generationSegmentsTrack');
const generationLabel = document.getElementById('generationLabel');
const dotRippleCanvas = document.getElementById('dotRippleCanvas');
const segmentsTrack = document.getElementById('segmentsTrack');
const isolateLabel = document.getElementById('isolateLabel');
const isolateCancelBtn = document.getElementById('isolateCancelBtn');
const modelViewerContainer = document.getElementById('modelViewerContainer');
const modelViewer = document.getElementById('modelViewer');
const modelStatusBadge = document.getElementById('modelStatusBadge');
const modelStatusText = document.getElementById('modelStatusText');
const connectionStatus = document.getElementById('connectionStatus');
const tooltip = document.getElementById('tooltip');
const blenderConnectUrl = document.getElementById('blenderConnectUrl');
const blenderCopyBtn = document.getElementById('blenderCopyBtn');

let stream = null;
let capturedBlob = null;
let isolateCancelled = false;
let pendingIsolatedBlob = null;
let previewModelUrl = null;
let finalModelUrl = null;
let cameraActive = false;
let activeGenerationEventSources = [];
let generationCancelled = false;
let facingMode = 'environment'; // toggled by flip button
let generationFakeInterval = null;

function showPhotoReview(pngBlob) {
  pendingIsolatedBlob = pngBlob;
  controlsMain.classList.add('review-mode');
}

function hidePhotoReview() {
  pendingIsolatedBlob = null;
  controlsMain.classList.remove('review-mode');
}

function showGenerationControls() {
  controlsMain.classList.add('generation-mode');
  updateGenerationProgress('Generating...', 0);
  // Fake crawl 0→40% until first real progress event arrives
  let fakePct = 0;
  generationFakeInterval = setInterval(() => {
    if (generationCancelled) { clearInterval(generationFakeInterval); generationFakeInterval = null; return; }
    fakePct += (40 - fakePct) * 0.03;
    updateGenerationProgress('Generating...', fakePct);
  }, 100);
}

function stopGenerationFakeCrawl() {
  if (generationFakeInterval) { clearInterval(generationFakeInterval); generationFakeInterval = null; }
}

function hideGenerationControls() {
  stopGenerationFakeCrawl();
  controlsMain.classList.remove('generation-mode');
}

function showModelReadyControls() {
  controlsMain.classList.add('model-ready-mode');
  sendBtn.disabled = false;
}

function hideModelReadyControls() {
  controlsMain.classList.remove('model-ready-mode');
  sendBtn.disabled = true;
}

function updateGenerationProgress(text, percentage = 0) {
  if (generationLabel) generationLabel.textContent = text;
  updateGenerationSegments(percentage);
}

function closeGenerationStreams() {
  activeGenerationEventSources.forEach(es => {
    try { es.close(); } catch (_) { /* ignore */ }
  });
  activeGenerationEventSources = [];
}

function resetToStart() {
  generationCancelled = true;
  stopGenerationFakeCrawl();
  closeGenerationStreams();

  if (window.pointCloudLoader) window.pointCloudLoader.stop();

  hidePhotoReview();
  hideGenerationControls();
  hideModelReadyControls();

  preview.style.display = 'none';
  preview.src = '';
  modelViewerContainer.style.display = 'none';
  modelViewer.removeAttribute('src');
  modelViewer.style.opacity = '0';
  modelViewer.style.pointerEvents = 'none';
  modelStatusBadge.style.display = 'none';

  capturedBlob = null;
  pendingIsolatedBlob = null;
  previewModelUrl = null;
  finalModelUrl = null;

  captureBtn.disabled = false;

  startCamera();
}

function confirmPhoto() {
  if (!pendingIsolatedBlob) return;
  const blob = pendingIsolatedBlob;
  hidePhotoReview();
  generate3DInBackground(blob);
}

function retakePhoto() {
  hidePhotoReview();
  preview.style.display = 'none';
  preview.src = '';
  capturedBlob = null;
  previewModelUrl = null;
  finalModelUrl = null;
  captureBtn.disabled = false;
  hideModelReadyControls();

  startCamera();
}

// ── Segmented loader ──────────────────────────────────────────────────────

const SEGMENT_COUNT = 20;
const segments = [];
const generationSegments = [];

function applySegmentStyles(segsArray, percentage) {
  const filled = Math.round((percentage / 100) * SEGMENT_COUNT);
  segsArray.forEach((seg, i) => {
    if (i < filled) {
      seg.style.background = 'rgba(255,255,255,1)';
      seg.style.boxShadow = '0 0 6px rgba(255,255,255,0.65), 0 0 14px rgba(255,255,255,0.3)';
    } else {
      const fadeBars = 1 + Math.round((filled / SEGMENT_COUNT) * 7);
      const pos = i - filled;
      const t = Math.min(pos / fadeBars, 1);
      const alpha = 0.30 - 0.22 * t;
      seg.style.background = `rgba(255,255,255,${alpha.toFixed(2)})`;
      seg.style.boxShadow = 'none';
    }
  });
}

function initSegments() {
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    segmentsTrack.appendChild(seg);
    segments.push(seg);
  }
}

function initGenerationSegments() {
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    generationSegmentsTrack.appendChild(seg);
    generationSegments.push(seg);
  }
}

function updateSegments(percentage) {
  applySegmentStyles(segments, percentage);
}

function updateGenerationSegments(percentage) {
  applySegmentStyles(generationSegments, percentage);
}

// ── Dot ripple canvas ─────────────────────────────────────────────────────

let dotRippleRAF = null;

function startDotRipple() {
  if (dotRippleRAF) return;
  dotRippleCanvas.style.display = 'block';
  const ctx = dotRippleCanvas.getContext('2d');
  const spacing = 22;
  const dotR = 1.5;
  let frame = 0;

  function draw() {
    const w = dotRippleCanvas.offsetWidth;
    const h = dotRippleCanvas.offsetHeight;
    if (dotRippleCanvas.width !== w) dotRippleCanvas.width = w;
    if (dotRippleCanvas.height !== h) dotRippleCanvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    for (let x = spacing / 2; x < w; x += spacing) {
      for (let y = spacing / 2; y < h; y += spacing) {
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        const wave = Math.sin(dist / 34 - frame / 33);
        const alpha = 0.04 + ((wave + 1) / 2) * 0.52;
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;
        ctx.fill();
      }
    }
    frame++;
    dotRippleRAF = requestAnimationFrame(draw);
  }

  draw();
}

function stopDotRipple() {
  if (dotRippleRAF) { cancelAnimationFrame(dotRippleRAF); dotRippleRAF = null; }
  dotRippleCanvas.style.display = 'none';
}

// ── Unified show/hide for the isolation loading state ────────────────────

function showIsolateLoading() {
  isolateCancelled = false;
  controlsMain.classList.add('isolate-mode');
  updateSegments(0);
}

function hideIsolateLoading() {
  controlsMain.classList.remove('isolate-mode');
}

function cancelIsolate() {
  isolateCancelled = true;
  hideIsolateLoading();
  stopDotRipple();
  preview.style.display = 'none';
  preview.src = '';
  capturedBlob = null;
  captureBtn.disabled = false;
  startCamera();
}

function updateProgress(text, percentage = 0) {
  if (isolateLabel) isolateLabel.textContent = text;
  updateSegments(percentage);
}

// Camera
async function startCamera() {
  if (cameraActive) return;
  
  try {
    console.log('[Camera] Starting camera...');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false
    });
    video.srcObject = stream;
    video.style.display = 'block';
    placeholder.style.display = 'none';
    preview.style.display = 'none';
    cameraActive = true;
    
    captureBtn.disabled = false;
    hideModelReadyControls();
    
    console.log('[Camera] ✓ Ready');
  } catch (err) {
    console.error('[Camera] Access denied:', err.name, err.message);
    alert(`Unable to access camera.\nError: ${err.name}\n${err.message}`);
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  video.style.display = 'none';
  cameraActive = false;
}

async function capture() {
  // Start camera if not already active
  if (!cameraActive) {
    await startCamera();
    return;
  }
  
  console.log('[Capture] Taking photo...');
  
  const ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);
  
  canvas.toBlob(async blob => {
    capturedBlob = blob;
    previewModelUrl = null;
    finalModelUrl = null;
    
    // Stop point cloud and hide model viewer when capturing new photo
    if (window.pointCloudLoader) window.pointCloudLoader.stop();
    modelViewerContainer.style.display = 'none';
    
    stopCamera();
    captureBtn.disabled = true;
    hideModelReadyControls();
    
    console.log('[Capture] ✓ Photo captured');
    
    // Show captured image immediately
    const capturedUrl = URL.createObjectURL(blob);
    preview.src = capturedUrl;
    preview.style.display = 'block';
    preview.onload = () => {
      placeholder.style.display = 'none';
    };
    
    // Step 1: Isolate background
    try {
      showIsolateLoading();
      updateProgress('Isolating object...', 0);

      console.log('[Isolate] Starting background removal...');

      // Animated crawl 0→85% while API call is in-flight
      let fakePct = 0;
      const fakeInterval = setInterval(() => {
        if (isolateCancelled) { clearInterval(fakeInterval); return; }
        // Slow exponential crawl: asymptotically approaches 85
        fakePct += (85 - fakePct) * 0.04;
        updateProgress('Isolating object...', fakePct);
      }, 80);

      const isolatedBlob = await isolateObject(blob);
      clearInterval(fakeInterval);

      console.log(`[Isolate] ✓ Complete (${(isolatedBlob.size / 1024).toFixed(2)} KB)`);

      // Ensure blob is PNG format for Tripo
      const pngBlob = new Blob([isolatedBlob], { type: 'image/png' });

      // Fill bar to 100%, then reveal review
      updateProgress('Ready!', 100);
      await new Promise(r => setTimeout(r, 500));
      if (isolateCancelled) return;
      hideIsolateLoading();

      // Swap to isolated image now that loading is hidden
      const isolatedUrl = URL.createObjectURL(pngBlob);
      preview.src = isolatedUrl;
      showPhotoReview(pngBlob);

    } catch (err) {
      hideIsolateLoading();
      console.error('[Isolate] ✗ Failed:', err.message);
      alert('Background removal failed. Please try again.');

      // Re-enable capture button so user can try again
      captureBtn.disabled = false;
      return;
    }
  }, 'image/png');
}

// Generate 3D model in background
async function generate3DInBackground(imageBlob) {
  generationCancelled = false;

  // Hide captured image — point cloud / model use the same viewport
  preview.style.display = 'none';
  preview.src = '';

  hideModelReadyControls();
  showGenerationControls();
  captureBtn.disabled = true;

  // Show model viewer layer with point cloud loader
  modelViewerContainer.style.display = 'block';

  // Start the point cloud floating animation, seeded with the captured photo
  if (window.pointCloudLoader) {
    if (imageBlob) {
      window.pointCloudLoader.setImageBlob(imageBlob);
    }
    window.pointCloudLoader.start();
  }

  try {
    console.log('[3D] Starting generation (preview + final)...');

    // Step 1: Create both tasks
    const { preview_task_id, final_task_id } = await createGenerationTasks(imageBlob);

    console.log('[3D] Preview task:', preview_task_id);
    console.log('[3D] Final task:', final_task_id);

    // Step 2: Stream progress for both tasks in parallel
    streamTaskProgress(preview_task_id, 'preview');
    streamTaskProgress(final_task_id, 'final');

  } catch (err) {
    if (generationCancelled) return;
    console.error('[3D] ✗ Generation failed:', err.message);
    if (window.pointCloudLoader) {
      window.pointCloudLoader.stop();
    }
    hideGenerationControls();
    alert('3D generation failed. Please try again.');
    captureBtn.disabled = false;
  }
}

// Create both preview and final generation tasks
async function createGenerationTasks(imageBlob) {
  console.log('[API] Generate3D - Creating tasks...');
  
  const pngBlob = imageBlob.type === 'image/png' ? imageBlob : new Blob([imageBlob], { type: 'image/png' });
  
  const formData = new FormData();
  formData.append('image', pngBlob, 'image.png');
  
  const res = await fetch(`${API_BASE}/generate3d`, {
    method: 'POST',
    body: formData
  });
  
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || '3D generation failed');
  }
  
  const data = await res.json();
  return data; // Returns { preview_task_id, final_task_id }
}

// Stream progress for a single task using SSE
function streamTaskProgress(taskId, taskType) {
  const eventSource = new EventSource(`${API_BASE}/generate3d/${taskId}/stream`);
  activeGenerationEventSources.push(eventSource);
  
  console.log(`[3D ${taskType}] Starting SSE stream for task ${taskId}`);
  
  eventSource.addEventListener('progress', (event) => {
    if (generationCancelled) return;
    stopGenerationFakeCrawl();
    const data = JSON.parse(event.data);
    console.log(`[3D ${taskType}] Progress: ${data.progress}% - Status: ${data.status}`);

    if (taskType === 'preview') {
      updateGenerationProgress(`Generating... ${data.progress}%`, data.progress);
    } else if (taskType === 'final' && data.progress) {
      updateGenerationProgress(`Texturing... ${data.progress}%`, Math.min(95, 50 + data.progress / 2));
    }
  });
  
  eventSource.addEventListener('complete', (event) => {
    if (generationCancelled) {
      eventSource.close();
      return;
    }
    const data = JSON.parse(event.data);
    console.log(`[3D ${taskType}] ✓ Complete! URL:`, data.model_url);
    
    if (taskType === 'preview') {
      previewModelUrl = data.model_url;
      
      // Proxy the model URL through our server to avoid CORS
      const proxiedUrl = `${API_BASE}/proxy-model?url=${encodeURIComponent(previewModelUrl)}`;
      
      // Trigger point cloud assembly animation using the preview GLB shape
      // Don't load it into model-viewer yet — keep point cloud visible
      if (window.pointCloudLoader) {
        window.pointCloudLoader.assembleFromURL(proxiedUrl);
      }
      
      console.log('[3D] Preview model loaded — assembling point cloud (staying as particles)');
      updateGenerationProgress('Assembling preview...', 75);
      
    } else {
      finalModelUrl = data.model_url;
      
      // Proxy the model URL through our server to avoid CORS
      const proxiedUrl = `${API_BASE}/proxy-model?url=${encodeURIComponent(finalModelUrl)}`;
      
      // Start loading final model into model-viewer (still hidden behind point cloud)
      modelViewer.setAttribute('src', proxiedUrl);
      
      console.log('[3D] Final model URL set — preloading while point cloud plays...');
      
      // Wait for BOTH: model-viewer fully loaded AND a minimum 3s buffer
      const minDelay = new Promise(r => setTimeout(r, 3000));
      const modelLoaded = new Promise(r => {
        modelViewer.addEventListener('load', r, { once: true });
      });
      
      Promise.all([minDelay, modelLoaded]).then(() => {
        if (generationCancelled) return;
        console.log('[3D] Final model ready — crossfading from point cloud');
        
        updateGenerationProgress('Finalizing...', 100);
        
        if (window.pointCloudLoader) {
          window.pointCloudLoader.crossfadeToModel();
        } else {
          modelViewer.style.opacity = '1';
          modelViewer.style.pointerEvents = '';
        }
        
        hideGenerationControls();
        showModelReadyControls();
      });
    }
    
    eventSource.close();
  });
  
  eventSource.addEventListener('error', (event) => {
    let errorMsg = 'Unknown error';
    try {
      const data = JSON.parse(event.data);
      errorMsg = data.error || errorMsg;
    } catch (e) {
      // If parsing fails, use generic error
    }
    
    console.error(`[3D ${taskType}] ✗ Error:`, errorMsg);
    
    if (generationCancelled) {
      eventSource.close();
      return;
    }

    if (taskType === 'preview') {
      if (window.pointCloudLoader) window.pointCloudLoader.stop();
      hideGenerationControls();
      alert(`Preview model generation failed: ${errorMsg}`);
      captureBtn.disabled = false;
    } else {
      console.warn('[3D] Final model failed, but preview is available');
    }
    
    eventSource.close();
  });
  
  // Handle connection errors
  eventSource.onerror = (error) => {
    console.error(`[3D ${taskType}] SSE connection error:`, error);
    
    if (generationCancelled) {
      eventSource.close();
      return;
    }

    if (taskType === 'preview' && !previewModelUrl) {
      if (window.pointCloudLoader) window.pointCloudLoader.stop();
      hideGenerationControls();
      alert('Connection lost while generating model. Please try again.');
      captureBtn.disabled = false;
    }
    
    eventSource.close();
  };
}

// Send pre-generated model to Blender
async function sendToBlender() {
  const modelUrl = finalModelUrl || previewModelUrl;
  
  if (!modelUrl) {
    console.error('[Relay] No 3D model ready');
    return;
  }
  
  sendBtn.disabled = true;
  
  try {
    showIsolateLoading();
    updateProgress('Sending to Blender...', 95);

    console.log('[Relay] Sending model to Blender...');

    await sendToRelay(modelUrl);

    hideIsolateLoading();
    console.log('[Relay] ✓ Sent! Check Blender viewport');

    // Re-enable buttons but don't reset the app
    sendBtn.disabled = false;

  } catch (err) {
    hideIsolateLoading();
    console.error('[Relay] ✗ Failed:', err.message);
    sendBtn.disabled = false;
    alert('Failed to send to Blender. Is Blender connected?');
  }
}

// API calls
async function isolateObject(blob) {
  console.log('[API] Isolate - Sending request with blob size:', blob.size);
  
  const formData = new FormData();
  formData.append('image', blob, 'photo.png');
  
  const res = await fetch(`${API_BASE}/isolate`, {
    method: 'POST',
    body: formData
  });
  
  console.log('[API] Isolate - Response status:', res.status);
  console.log('[API] Isolate - Response headers:', Object.fromEntries(res.headers.entries()));
  
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    console.error('[API] Isolate - Error response:', err);
    throw new Error(err.detail || 'Isolation failed');
  }
  
  const resultBlob = await res.blob();
  console.log('[API] Isolate - Result blob size:', resultBlob.size);
  console.log('[API] Isolate - Result blob type:', resultBlob.type);
  
  return resultBlob;
}

async function sendToRelay(modelUrl) {
  const res = await fetch(`${API_BASE}/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target: 'blender',
      type: 'model',
      url: modelUrl
    })
  });
  
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Relay failed');
  }
}

// Load Blender connection info and log it
async function loadConnectionInfo() {
  try {
    const res = await fetch(`${API_BASE}/connection-info`);
    if (res.ok) {
      const data = await res.json();
      if (data.ws_url) {
        console.log('[BlenderWS] WebSocket URL:', data.ws_url);
        console.log('[BlenderWS] Connection type:', data.connection_type);
        console.log('[BlenderWS] Copy this URL to Blender add-on (N-panel → WS Import)');

        const wsUrl = data.ws_url;
        if (blenderConnectUrl) blenderConnectUrl.textContent = wsUrl;
        if (blenderCopyBtn) blenderCopyBtn.dataset.url = wsUrl;

        // Update connection status
        const isConnected = data.clients && data.clients.blender > 0;
        updateConnectionStatus(isConnected);
      }
    }
  } catch (err) {
    console.warn('[BlenderWS] Could not load connection info:', err);
    updateConnectionStatus(false);
  }
}

// Update connection status indicator and tooltip
function updateConnectionStatus(isConnected) {
  if (isConnected) {
    connectionStatus.classList.add('connected');
    tooltip.textContent = 'Blender: Connected';
  } else {
    connectionStatus.classList.remove('connected');
    tooltip.textContent = 'Blender: Disconnected';
  }
}

// Poll connection status periodically
function startConnectionMonitoring() {
  // Check immediately
  loadConnectionInfo();
  
  // Then check every 3 seconds
  setInterval(() => {
    loadConnectionInfo();
  }, 3000);
}

// Check camera permission and auto-start if already granted
async function checkCameraPermission() {
  try {
    const result = await navigator.permissions.query({ name: 'camera' });
    if (result.state === 'granted') {
      startCamera();
    }
    // 'prompt' or 'denied' → leave placeholder visible
    result.addEventListener('change', () => {
      if (result.state === 'granted' && !cameraActive) startCamera();
    });
  } catch {
    // Permissions API unavailable (some browsers) — leave placeholder
  }
}

// Init function
function init() {
  initSegments();
  initGenerationSegments();

  // Event listeners
  captureBtn.addEventListener('click', capture);
  sendBtn.addEventListener('click', sendToBlender);
  confirmBtn.addEventListener('click', confirmPhoto);
  retakeBtn.addEventListener('click', retakePhoto);
  isolateCancelBtn.addEventListener('click', cancelIsolate);
  cancelGenerationBtn.addEventListener('click', resetToStart);
  startAgainBtn.addEventListener('click', resetToStart);

  if (blenderCopyBtn) {
    const copyToast = document.getElementById('copyToast');
    let toastTimeout = null;
    blenderCopyBtn.addEventListener('click', () => {
      const url = blenderCopyBtn.dataset.url;
      if (!url) return;
      navigator.clipboard.writeText(url).then(() => {
        if (copyToast) {
          copyToast.classList.add('show');
          clearTimeout(toastTimeout);
          toastTimeout = setTimeout(() => copyToast.classList.remove('show'), 1800);
        }
      });
    });
  }

  // Tapping the permission placeholder requests camera access
  placeholder.addEventListener('click', () => {
    if (!cameraActive) startCamera();
  });

  // Flip camera button (mobile only — hidden on desktop via CSS)
  const flipBtn = document.getElementById('flipBtn');
  if (flipBtn) {
    flipBtn.addEventListener('click', async () => {
      if (!cameraActive) return;
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      stopCamera();
      await startCamera();
    });
  }

  console.log('[App] Ready.');
  startConnectionMonitoring();
  checkCameraPermission();
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

