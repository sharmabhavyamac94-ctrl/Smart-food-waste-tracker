import "../platescan.css";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Download, History, Play, Square, Sparkles, RefreshCw, ArrowLeft, ImagePlus } from "lucide-react";
const FRAME_MS = 220;
const CANDIDATE_MS = 1800;
const MIN_TRIGGER = 0.038;
const MIN_CHANGE = 0.032;
const CLEAR_THRESHOLD = 0.024;
const CONFIRM_MS = 520;
const MAX_QUEUE = 8;
const MAX_WORKERS = 2;
async function api(path, init) {
    try {
        const r = await fetch(path, init);
        const text = await r.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        }
        catch {
            data = { error: text || "Server returned an invalid response." };
        }
        if (!r.ok)
            throw new Error(data.error || `Request failed (${r.status})`);
        return data;
    }
    catch (e) {
        if (e instanceof TypeError)
            throw new Error("Backend is not running. Keep the VS Code terminal running with npm run dev.");
        throw e;
    }
}
function PlateScanApp() {
    const [view, setView] = useState("home");
    const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
    const [day, setDay] = useState("Day 1");
    const [round, setRound] = useState(1);
    const [sid, setSid] = useState(null);
    const [plates, setPlates] = useState([]);
    const [analysis, setAnalysis] = useState(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState("");
    const [camera, setCamera] = useState(false);
    const [auto, setAuto] = useState(false);
    const [det, setDet] = useState("idle");
    const [queueSize, setQueueSize] = useState(0);
    const [activeAnalyses, setActiveAnalyses] = useState(0);
    const [history, setHistory] = useState({ sessions: [], days: [] });
    const [selectedDay, setSelectedDay] = useState(null);
    const [selectedSession, setSelectedSession] = useState(null);
    const [uploadFiles, setUploadFiles] = useState([]);
    const [uploading, setUploading] = useState(false);
    const [manualMode, setManualMode] = useState("round");
    const [singleFile, setSingleFile] = useState(null);
    const video = useRef(null);
    const stream = useRef(null);
    const timer = useRef(null);
    const runningRef = useRef(false);
    const stateRef = useRef("waiting");
    const referenceRef = useRef(null);
    const lockedRef = useRef(null);
    const changedSinceRef = useRef(0);
    const candidateRef = useRef({ start: 0, best: -1, blob: null, lastShot: 0 });
    const queueRef = useRef([]);
    const workersRef = useRef(0);
    const sidRef = useRef(null);
    const cameraRef = useRef(false);
    const autoRef = useRef(false);
    const lastTickRef = useRef(0);
    const tickBusyRef = useRef(false);
    useEffect(() => () => stopAll(), []);
    useEffect(() => { sidRef.current = sid; }, [sid]);
    useEffect(() => { cameraRef.current = camera; }, [camera]);
    useEffect(() => { autoRef.current = auto; }, [auto]);
    useEffect(() => {
        if (view === "live" && sid && !stream.current)
            void startCamera();
    }, [view, sid]);
    function updateQueue() { setQueueSize(queueRef.current.length); setActiveAnalyses(workersRef.current); setBusy(queueRef.current.length > 0 || workersRef.current > 0); }
    async function analyzeSingle() {
        if (!singleFile) {
            setMsg("Choose a photo first.");
            return;
        }
        const ok = await analyze(singleFile);
        setView("single");
        if (ok)
            setMsg("Photo analyzed successfully.");
    }
    async function startManualBatch() {
        if (!uploadFiles.length) {
            setMsg("Select one or more plate photos first.");
            return;
        }
        setUploading(true);
        setPlates([]);
        setAnalysis(null);
        try {
            const d = await api("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionDate: date, dayLabel: day, roundNumber: manualMode === "custom" ? 0 : round, sessionType: manualMode }) });
            setSid(d.id);
            sidRef.current = d.id;
            setRound(d.roundNumber);
            setMsg(`Analyzing ${uploadFiles.length} uploaded photo(s)…`);
            let ok = 0;
            for (const file of uploadFiles)
                if (await analyze(file, d.id))
                    ok++;
            await api(`/api/sessions/${d.id}/finish`, { method: "POST" });
            setMsg(`Finished: ${ok}/${uploadFiles.length} photo(s) contained a clear plate.`);
            setView("round");
        }
        catch (e) {
            setMsg(e instanceof Error ? e.message : "Upload analysis failed");
        }
        finally {
            setUploading(false);
        }
    }
    async function startSession() {
        try {
            const d = await api("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionDate: date, dayLabel: day, roundNumber: round, sessionType: "round" }) });
            setSid(d.id);
            sidRef.current = d.id;
            setRound(d.roundNumber);
            setPlates([]);
            setAnalysis(null);
            setQueueSize(0);
            setView("live");
        }
        catch (e) {
            setMsg(e instanceof Error ? e.message : "Could not start session");
        }
    }
    async function startCamera() {
        try {
            if (!navigator.mediaDevices?.getUserMedia)
                throw new Error("Camera access is not available in this browser.");
            const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
            stream.current = s;
            cameraRef.current = true;
            setCamera(true);
            if (video.current) {
                video.current.srcObject = s;
                await video.current.play();
            }
            setMsg("Camera ready. Keep it fixed over the collection point, then press Start Auto Scan.");
        }
        catch (e) {
            cameraRef.current = false;
            setCamera(false);
            setMsg(e instanceof Error ? e.message : "Camera permission was denied or unavailable.");
        }
    }
    function stopAll() {
        stopAuto();
        stream.current?.getTracks().forEach(t => t.stop());
        stream.current = null;
        cameraRef.current = false;
        setCamera(false);
    }
    function frameSignature() {
        const v = video.current;
        if (!v?.videoWidth)
            return null;
        const c = document.createElement("canvas");
        c.width = 80;
        c.height = 45;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx)
            return null;
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        const a = new Float32Array(c.width * c.height);
        for (let i = 0, j = 0; i < px.length; i += 4, j++)
            a[j] = (.299 * px[i] + .587 * px[i + 1] + .114 * px[i + 2]) / 255;
        return a;
    }
    function diff(a, b) { let s = 0; for (let i = 0; i < a.length; i++)
        s += Math.abs(a[i] - b[i]); return s / a.length; }
    function sharpness(c) {
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx)
            return 0;
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let score = 0, n = 0;
        for (let y = 1; y < c.height - 1; y += 2)
            for (let x = 1; x < c.width - 1; x += 2) {
                const i = (y * c.width + x) * 4;
                const g = (.299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2]);
                const l = (.299 * d[i - 4] + .587 * d[i - 3] + .114 * d[i - 2]) + (.299 * d[i + 4] + .587 * d[i + 5] + .114 * d[i + 6]);
                const u = i - c.width * 4, v = i + c.width * 4;
                const ud = (.299 * d[u] + .587 * d[u + 1] + .114 * d[u + 2]) + (.299 * d[v] + .587 * d[v + 1] + .114 * d[v + 2]);
                score += Math.abs(4 * g - l - ud);
                n++;
            }
        return n ? score / n : 0;
    }
    function captureBestFrame() {
        return new Promise(resolve => {
            const v = video.current;
            if (!v?.videoWidth)
                return resolve(null);
            const c = document.createElement("canvas");
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            const ctx = c.getContext("2d");
            if (!ctx)
                return resolve(null);
            ctx.drawImage(v, 0, 0);
            const score = sharpness(c);
            c.toBlob(b => resolve(b ? { blob: b, score } : null), "image/jpeg", .86);
        });
    }
    async function sendAnalysis(blob, sessionOverride) {
        try {
            const fd = new FormData();
            fd.append("image", blob, "plate.jpg");
            const activeSession = sessionOverride ?? sidRef.current;
            if (activeSession)
                fd.append("sessionId", activeSession);
            const d = await api("/api/analyze-food", { method: "POST", body: fd });
            setAnalysis(d);
            if (d.plate)
                setPlates(p => [...p, d.plate]);
            return Boolean(d.plateDetected);
        }
        catch (e) {
            setMsg(e instanceof Error ? e.message : "AI analysis failed");
            return false;
        }
    }
    async function analyze(blob, sessionOverride) {
        setBusy(true);
        setMsg("AI analyzing the selected plate…");
        try {
            return await sendAnalysis(blob, sessionOverride);
        }
        finally {
            setBusy(queueRef.current.length > 0 || workersRef.current > 0);
        }
    }
    async function drainQueue() {
        if (!sidRef.current)
            return;
        while (workersRef.current < MAX_WORKERS && queueRef.current.length) {
            const blob = queueRef.current.shift();
            workersRef.current++;
            updateQueue();
            sendAnalysis(blob, sidRef.current).then(ok => { if (ok)
                setMsg("Plate analyzed. Camera keeps watching for the next plate…"); }).finally(() => { workersRef.current--; updateQueue(); drainQueue(); });
        }
    }
    function enqueueFrame(blob) {
        if (queueRef.current.length >= MAX_QUEUE) {
            setMsg("Analysis queue is full for a moment; keep the camera fixed and it will catch up.");
            return;
        }
        queueRef.current.push(blob);
        updateQueue();
        drainQueue();
    }
    async function scanTick() {
        if (tickBusyRef.current || !runningRef.current || !cameraRef.current)
            return;
        tickBusyRef.current = true;
        try {
            const now = performance.now();
            if (now - lastTickRef.current < FRAME_MS)
                return;
            lastTickRef.current = now;
            const f = frameSignature();
            if (!f)
                return;
            const state = stateRef.current;
            if (!referenceRef.current) {
                referenceRef.current = f;
                stateRef.current = "waiting";
                setDet("waiting");
                return;
            }
            const ref = referenceRef.current;
            const fromEmpty = diff(f, ref);
            if (state === "waiting") {
                if (fromEmpty > MIN_TRIGGER) {
                    candidateRef.current = { start: now, best: -1, blob: null, lastShot: 0 };
                    stateRef.current = "collecting";
                    setDet("capturing");
                    setMsg("New plate detected — collecting the sharpest frame…");
                }
                else {
                    const blended = new Float32Array(ref.length);
                    for (let i = 0; i < ref.length; i++)
                        blended[i] = ref[i] * .985 + f[i] * .015;
                    referenceRef.current = blended;
                }
                return;
            }
            if (state === "collecting") {
                const c = candidateRef.current;
                if (fromEmpty < CLEAR_THRESHOLD) {
                    c.start = now;
                    c.best = -1;
                    c.blob = null;
                    stateRef.current = "waiting";
                    setDet("waiting");
                    return;
                }
                if (now - c.lastShot >= FRAME_MS - 20) {
                    c.lastShot = now;
                    const shot = await captureBestFrame();
                    if (shot && shot.score > c.best) {
                        c.best = shot.score;
                        c.blob = shot.blob;
                    }
                }
                if (now - c.start >= CANDIDATE_MS && c.blob) {
                    const blob = c.blob;
                    c.blob = null;
                    enqueueFrame(blob);
                    lockedRef.current = f;
                    changedSinceRef.current = 0;
                    stateRef.current = "holding";
                    setDet("analyzing");
                    setMsg(`Best frame queued. ${queueRef.current.length} waiting • ${workersRef.current} analyzing.`);
                }
                return;
            }
            const locked = lockedRef.current;
            const fromLocked = locked ? diff(f, locked) : 0;
            const clear = fromEmpty < CLEAR_THRESHOLD;
            if (clear) {
                changedSinceRef.current = 0;
                stateRef.current = "waiting";
                setDet("waiting");
                setMsg(queueRef.current.length || workersRef.current ? "Plate saved. AI is still processing while the camera watches…" : "Waiting for the next plate…");
                return;
            }
            if (fromLocked > MIN_CHANGE) {
                if (!changedSinceRef.current)
                    changedSinceRef.current = now;
                if (now - changedSinceRef.current >= CONFIRM_MS) {
                    candidateRef.current = { start: now, best: -1, blob: null, lastShot: 0 };
                    stateRef.current = "collecting";
                    setDet("capturing");
                    setMsg("New plate/change detected — collecting another sharp frame…");
                    changedSinceRef.current = 0;
                }
            }
            else
                changedSinceRef.current = 0;
        }
        finally {
            tickBusyRef.current = false;
        }
    }
    function startAuto() {
        if (runningRef.current || !cameraRef.current) {
            setMsg("Start the camera first.");
            return;
        }
        const f = frameSignature();
        if (f)
            referenceRef.current = f;
        lockedRef.current = null;
        changedSinceRef.current = 0;
        candidateRef.current = { start: 0, best: -1, blob: null, lastShot: 0 };
        runningRef.current = true;
        autoRef.current = true;
        setAuto(true);
        stateRef.current = "waiting";
        setDet("waiting");
        setMsg("Auto Scan ON — watching continuously. New plates are captured in ~2 seconds; AI runs in parallel.");
        const loop = () => { if (!runningRef.current)
            return; scanTick(); timer.current = window.setTimeout(loop, FRAME_MS); };
        loop();
    }
    function stopAuto() {
        runningRef.current = false;
        autoRef.current = false;
        if (timer.current) {
            clearTimeout(timer.current);
            timer.current = null;
        }
        stateRef.current = "waiting";
        setAuto(false);
        setDet("idle");
    }
    async function endRound() {
        stopAuto();
        stream.current?.getTracks().forEach(t => t.stop());
        stream.current = null;
        cameraRef.current = false;
        setCamera(false);
        if (sidRef.current) {
            try {
                await api(`/api/sessions/${sidRef.current}/finish`, { method: "POST" });
            }
            catch (e) {
                setMsg(e instanceof Error ? e.message : "Could not finish round");
            }
        }
        setView("round");
    }
    async function loadHistory() { try {
        setHistory(await api("/api/history"));
        setView("history");
    }
    catch (e) {
        setMsg(e instanceof Error ? e.message : "Could not load history");
    } }
    async function openDay(d) { try {
        setSelectedDay(await api(`/api/days/${d}`));
        setSelectedSession(null);
        setView("day");
    }
    catch (e) {
        setMsg(e instanceof Error ? e.message : "Could not load day");
    } }
    async function openSession(id) { try {
        setSelectedSession(await api(`/api/sessions/${id}/summary`));
    }
    catch (e) {
        setMsg(e instanceof Error ? e.message : "Could not load round");
    } }
    const foodSummary = useMemo(() => { const m = new Map(); plates.forEach(p => p.foods.forEach(f => { const x = m.get(f.name) || { n: 0, p: [] }; x.n++; if (f.remainingPercent != null)
        x.p.push(f.remainingPercent); m.set(f.name, x); })); return [...m].map(([name, x]) => ({ name, count: x.n, avg: x.p.length ? Math.round(x.p.reduce((a, b) => a + b, 0) / x.p.length) : null })).sort((a, b) => b.count - a.count); }, [plates]);
    const leftover = plates.filter(p => p.foods.some(f => (f.remainingPercent ?? 0) > 0)).length;
    const leftoverRate = plates.length ? Math.round(leftover / plates.length * 100) : 0;
    const allP = plates.flatMap(p => p.foods.map(f => f.remainingPercent)).filter((x) => typeof x === "number");
    const avg = allP.length ? Math.round(allP.reduce((a, b) => a + b, 0) / allP.length) : null;
    function exportRound() { const b = new Blob([JSON.stringify({ date, day, round, plates, foodSummary, platesWithAnyLeftover: leftover, percentPlatesWithAnyLeftover: leftoverRate, avgObservedPercent: avg }, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `platescan-${date}-round-${round}.json`; a.click(); URL.revokeObjectURL(a.href); }
    if (view === "home")
        return _jsx("main", { className: "app", children: _jsxs("div", { className: "container", children: [_jsx(Nav, { onHistory: loadHistory }), _jsxs("section", { className: "hero", children: [_jsxs("span", { className: "badge", children: [_jsx(Sparkles, { size: 14 }), " Food Waste Intelligence"] }), _jsx("h1", { children: "See what children leave behind." }), _jsx("p", { className: "lead", children: "Keep one phone camera running over the collection point. PlateScan continuously watches for a new plate, collects the sharpest frame, queues it, and analyzes multiple plates in parallel." }), _jsxs("div", { className: "card", style: { padding: 22, marginTop: 22 }, children: [_jsx("h2", { children: "Start today\u2019s round" }), _jsxs("div", { className: "formgrid", children: [_jsxs("label", { children: ["Date", _jsx("input", { className: "input", type: "date", value: date, onChange: e => setDate(e.target.value) })] }), _jsxs("label", { children: ["Day label", _jsx("input", { className: "input", value: day, onChange: e => setDay(e.target.value) })] }), _jsxs("label", { children: ["Round", _jsx("input", { className: "input", type: "number", min: "1", value: round, onChange: e => setRound(Number(e.target.value)) })] })] }), _jsxs("button", { className: "btn btn-primary", style: { marginTop: 14 }, onClick: startSession, children: [_jsx(Camera, { size: 17 }), " Start Automatic Scan"] })] }), _jsxs("div", { className: "grid", style: { marginTop: 16 }, children: [_jsxs("div", { className: "card", style: { padding: 22 }, children: [_jsx("h3", { children: "🔎 Analyze Photo" }), _jsx("p", { className: "muted", children: "Manual photo upload: choose a plate image and get food, approximate amount, remaining %, and confidence." }), _jsx("input", { type: "file", accept: "image/jpeg,image/png,image/webp", onChange: e => setSingleFile(e.target.files?.[0] || null) }), _jsxs("button", { className: "btn btn-primary", style: { marginTop: 10 }, disabled: !singleFile || busy, onClick: analyzeSingle, children: [_jsx(ImagePlus, { size: 16 }), " Analyze Photo"] })] }), _jsxs("div", { className: "card", style: { padding: 22 }, children: [_jsx("h3", { children: "📷 Automatic Camera Scan" }), _jsx("p", { className: "muted", children: "Keep the phone camera running. PlateScan automatically selects a sharp frame, queues it for AI, and keeps watching for the next plate." }), _jsxs("button", { className: "btn btn-primary", onClick: startSession, children: [_jsx(Camera, { size: 16 }), " Start Automatic Scan"] })] })] }), _jsxs("div", { className: "card", style: { padding: 22, marginTop: 16 }, children: [_jsx("h3", { children: "Historical dashboard" }), _jsx("p", { className: "muted", children: "Today, yesterday and previous dates stay in SQLite, grouped into rounds and individual plates." }), _jsxs("button", { className: "btn btn-soft", onClick: loadHistory, children: [_jsx(History, { size: 16 }), " View History"] })] })] })] }) });
    if (view === "upload")
        return _jsx("main", { className: "app", children: _jsxs("div", { className: "container", children: [_jsx(Nav, { onHistory: loadHistory }), _jsxs("section", { style: { padding: "30px 0 55px" }, children: [_jsxs("button", { className: "btn btn-soft", onClick: () => setView("home"), children: [_jsx(ArrowLeft, { size: 16 }), " Back"] }), _jsx("span", { className: "badge", style: { marginTop: 18 }, children: "Manual upload" }), _jsx("h1", { style: { margin: "12px 0 5px" }, children: "Upload plate photos" }), _jsx("p", { className: "muted", children: "Upload one or multiple photos. Each photo gets the full PlateScan AI analysis." }), _jsxs("div", { className: "card", style: { padding: 22, marginTop: 16 }, children: [_jsxs("div", { className: "formgrid", children: [_jsxs("label", { children: ["Save to", _jsxs("select", { className: "input", value: manualMode, onChange: e => setManualMode(e.target.value), children: [_jsx("option", { value: "round", children: "Day \u2192 Round" }), _jsx("option", { value: "custom", children: "Day \u2192 Custom (no round)" })] })] }), _jsxs("label", { children: ["Date", _jsx("input", { className: "input", type: "date", value: date, onChange: e => setDate(e.target.value) })] }), _jsxs("label", { children: ["Day label", _jsx("input", { className: "input", value: day, onChange: e => setDay(e.target.value) })] }), _jsxs("label", { children: ["Round", _jsx("input", { className: "input", type: "number", min: "1", value: round, onChange: e => setRound(Number(e.target.value)) })] })] }), _jsxs("div", { style: { marginTop: 18 }, children: [_jsx("input", { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true, onChange: e => setUploadFiles(Array.from(e.target.files || [])) }), _jsxs("p", { className: "muted small", children: [uploadFiles.length, " photo(s) selected \u2022 ", manualMode === "custom" ? "saved directly under the day" : "saved in the selected round"] })] }), _jsx("button", { className: "btn btn-primary", disabled: !uploadFiles.length || uploading, onClick: startManualBatch, children: uploading ? _jsxs(_Fragment, { children: [_jsx(Play, { size: 16 }), " Analyzing\u2026"] }) : _jsxs(_Fragment, { children: [_jsx(ImagePlus, { size: 16 }), " Analyze Selected Photos"] }) }), _jsx("p", { children: msg })] }), plates.length > 0 && _jsxs("section", { className: "card", style: { padding: 22, marginTop: 16 }, children: [_jsx("h2", { children: "Uploaded plate results" }), _jsx(PlateList, { plates: plates })] })] })] }) });
    if (view === "single")
        return _jsx("main", { className: "app", children: _jsxs("div", { className: "container", children: [_jsx(Nav, { onHistory: loadHistory }), _jsxs("section", { style: { padding: "30px 0 55px" }, children: [_jsxs("button", { className: "btn btn-soft", onClick: () => setView("home"), children: [_jsx(ArrowLeft, { size: 16 }), " Back"] }), _jsx("span", { className: "badge", style: { marginTop: 18 }, children: "Single photo analysis" }), _jsx("h1", { style: { margin: "12px 0 5px" }, children: "PlateScan AI Result" }), _jsx("p", { className: "muted", children: "Full food identification and approximate leftover measurement." }), analysis && _jsx(ResultCard, { analysis: analysis }), _jsxs("div", { className: "card", style: { padding: 20, marginTop: 16 }, children: [_jsx("b", { children: "How precise can it be?" }), _jsx("p", { className: "muted", children: "Countable foods can be estimated as pieces and fractions when the image supports it, for example ~1.5 rotis. Rice, dal and sabzi are better reported as visible serving amounts. Exact grams/kg are not claimed from an image alone." })] })] })] }) });
    if (view === "live")
        return _jsx("main", { className: "app", children: _jsxs("div", { className: "container", children: [_jsx(Nav, { onHistory: loadHistory }), _jsxs("section", { style: { padding: "25px 0 50px" }, children: [_jsxs("span", { className: "badge", children: [day, " \u2022 Round ", round] }), _jsx("h1", { style: { margin: "12px 0 5px" }, children: "Automatic Scan" }), _jsxs("p", { className: "muted", children: [plates.length, " plates saved \u2022 ", activeAnalyses, " AI analysis running \u2022 ", queueSize, " queued"] }), _jsxs("div", { className: "card", style: { padding: 15, marginTop: 16 }, children: [_jsx("video", { className: "video", ref: video, playsInline: true, muted: true }), _jsxs("div", { style: { display: "flex", gap: 9, flexWrap: "wrap", marginTop: 12 }, children: [!auto ? _jsxs("button", { className: "btn btn-primary", disabled: !camera, onClick: startAuto, children: [_jsx(Play, { size: 16 }), " Start Auto Scan"] }) : _jsxs("button", { className: "btn btn-soft", onClick: stopAuto, children: [_jsx(Square, { size: 16 }), " Pause"] }), _jsx("button", { className: "btn btn-soft", onClick: endRound, children: "End Round" })] }), _jsx("p", { children: msg }), _jsxs("span", { className: "pill", children: ["Detector: ", det, " \u2022 frame window ~", Math.round(CANDIDATE_MS / 1000), "s \u2022 parallel workers ", MAX_WORKERS] })] }), _jsxs("div", { className: "grid3", style: { marginTop: 15 }, children: [_jsx(Stat, { title: "Plates scanned", value: String(plates.length) }), _jsx(Stat, { title: "Plates with food left", value: `${leftover} (${leftoverRate}%)` }), _jsx(Stat, { title: "Avg visual remaining", value: avg == null ? "—" : `${avg}%` })] }), _jsxs("section", { className: "card", style: { padding: 22, marginTop: 15 }, children: [_jsx("h2", { className: "sectiontitle", children: "Live plate history" }), _jsx(PlateList, { plates: plates })] })] })] }) });
    if (view === "round")
        return _jsx("main", { className: "app", children: _jsxs("div", { className: "container", children: [_jsx(Nav, { onHistory: loadHistory }), _jsxs("section", { style: { padding: "30px 0 55px" }, children: [_jsx("span", { className: "badge", children: "Round complete" }), _jsxs("h1", { style: { margin: "12px 0 5px" }, children: [day, " \u2022 ", manualMode === "custom" ? "Custom" : `Round ${round}`] }), _jsx("p", { className: "muted", children: "Every analyzed plate is saved locally." }), _jsxs("div", { className: "grid3", style: { marginTop: 16 }, children: [_jsx(Stat, { title: "Plates scanned", value: String(plates.length) }), _jsx(Stat, { title: "Children/plates leaving food", value: `${leftover} / ${plates.length} (${leftoverRate}%)` }), _jsx(Stat, { title: "Average visual remaining", value: avg == null ? "—" : `${avg}%` })] }), _jsxs("section", { className: "card chart", style: { marginTop: 16 }, children: [_jsx("h2", { className: "sectiontitle", children: "Which food was left most often?" }), foodSummary.length ? foodSummary.map(x => _jsxs("div", { className: "chartrow", children: [_jsx("b", { children: x.name }), _jsx("div", { className: "barwrap", children: _jsx("div", { className: "bar", style: { width: `${Math.max(4, (x.count / Math.max(1, foodSummary[0].count)) * 100)}%` } }) }), _jsxs("span", { children: [x.count, " plates"] })] }, x.name)) : _jsx("div", { className: "empty", children: "No food observations." })] }), _jsxs("section", { className: "card", style: { padding: 22, marginTop: 16 }, children: [_jsx("h2", { className: "sectiontitle", children: "Plate-by-plate history" }), _jsx(PlateList, { plates: plates })] }), _jsxs("div", { style: { marginTop: 15, display: "flex", gap: 9, flexWrap: "wrap" }, children: [_jsxs("button", { className: "btn btn-primary", onClick: exportRound, children: [_jsx(Download, { size: 16 }), " Export Round"] }), _jsxs("button", { className: "btn btn-soft", onClick: loadHistory, children: [_jsx(History, { size: 16 }), " Open Full History"] })] })] })] }) });
    if (view === "history")
        return _jsx("main", { className: "app", children: _jsxs("div", { className: "container", children: [_jsx(Nav, { onHistory: loadHistory }), _jsxs("section", { style: { padding: "30px 0 55px" }, children: [_jsxs("span", { className: "badge", children: [_jsx(History, { size: 14 }), " Daily history"] }), _jsx("h1", { style: { margin: "12px 0 5px" }, children: "Food waste over time" }), _jsx("p", { className: "muted", children: "Like a screen-time history, but for meals: each date \u2192 rounds \u2192 individual plates." }), _jsxs("div", { className: "card", style: { padding: 22, marginTop: 16 }, children: [_jsx("h2", { children: "Days" }), history.days.length ? history.days.map((d) => _jsxs("div", { className: "result", onClick: () => openDay(d.session_date), style: { cursor: "pointer" }, children: [_jsxs("div", { children: [_jsx("b", { children: d.session_date }), _jsxs("div", { className: "muted small", children: [d.day_label, " \u2022 ", d.rounds, " rounds"] })] }), _jsxs("div", { children: [_jsxs("span", { className: "pill", children: [d.plates, " plates"] }), " ", _jsxs("span", { className: "pill", children: [d.leftover_plates, " left food (", d.plates ? Math.round(d.leftover_plates / d.plates * 100) : 0, "%)"] })] })] }, d.session_date)) : _jsx("div", { className: "empty", children: "No history yet." })] }), _jsxs("div", { className: "card", style: { padding: 22, marginTop: 16 }, children: [_jsx("h2", { children: "All rounds" }), history.sessions.length ? history.sessions.map(s => _jsxs("div", { className: "result", onClick: () => openSession(s.id), style: { cursor: "pointer" }, children: [_jsxs("div", { children: [_jsxs("b", { children: [s.session_date, " \u2022 ", s.session_type === "custom" ? "Custom" : `Round ${s.round_number}`] }), _jsxs("div", { className: "muted small", children: [s.plate_count, " plates \u2022 ", new Date(s.started_at).toLocaleTimeString()] })] }), _jsxs("span", { className: "pill", children: [s.plates_with_leftovers, " with leftovers"] })] }, s.id)) : _jsx("div", { className: "empty", children: "No rounds yet." })] })] })] }) });
    if (view === "day")
        return _jsx("main", { className: "app", children: _jsxs("div", { className: "container", children: [_jsx(Nav, { onHistory: loadHistory }), _jsxs("section", { style: { padding: "30px 0 55px" }, children: [_jsxs("button", { className: "btn btn-soft", onClick: loadHistory, children: [_jsx(ArrowLeft, { size: 16 }), " Back to history"] }), _jsx("h1", { style: { margin: "18px 0 5px" }, children: selectedDay?.date }), _jsx("p", { className: "muted", children: "Daily food-waste summary" }), _jsxs("div", { className: "grid3", style: { marginTop: 16 }, children: [_jsx(Stat, { title: "Plates scanned", value: String(selectedDay?.totalPlates || 0) }), _jsx(Stat, { title: "Plates with leftovers", value: `${selectedDay?.leftoverPlates || 0} (${selectedDay?.percentPlatesWithAnyLeftover || 0}%)` }), _jsx(Stat, { title: "Rounds", value: String(selectedDay?.sessions?.length || 0) })] }), _jsxs("section", { className: "card chart", style: { marginTop: 16 }, children: [_jsx("h2", { className: "sectiontitle", children: "Food waste / leftover pattern" }), selectedDay?.food?.length ? selectedDay.food.map((f) => _jsxs("div", { className: "chartrow", children: [_jsx("b", { children: f.name }), _jsx("div", { className: "barwrap", children: _jsx("div", { className: "bar", style: { width: `${Math.max(4, (f.observations / (selectedDay.food[0].observations || 1)) * 100)}%` } }) }), _jsxs("span", { children: [f.observations, " plates"] })] }, f.name)) : _jsx("div", { className: "empty", children: "No food data for this day." })] }), _jsxs("section", { className: "card", style: { padding: 22, marginTop: 16 }, children: [_jsx("h2", { children: "Rounds" }), selectedDay?.sessions?.map((s) => _jsxs("div", { className: "result", onClick: () => openSession(s.id), style: { cursor: "pointer" }, children: [_jsxs("div", { children: [_jsx("b", { children: s.session_type === "custom" ? "Custom" : `Round ${s.round_number}` }), _jsxs("div", { className: "muted small", children: [s.plate_count, " plates"] })] }), _jsxs("span", { className: "pill", children: [s.plates_with_leftovers, " with leftovers"] })] }, s.id))] }), selectedSession && _jsxs("section", { className: "card", style: { padding: 22, marginTop: 16 }, children: [_jsxs("h2", { children: [selectedSession.session.day_label, " \u2022 ", selectedSession.session.session_type === "custom" ? "Custom" : `Round ${selectedSession.session.round_number}`] }), _jsxs("div", { className: "grid3", children: [_jsx(Stat, { title: "Plates", value: String(selectedSession.totalPlates) }), _jsx(Stat, { title: "Leftover plates", value: `${selectedSession.leftoverPlates} (${selectedSession.percentPlatesWithAnyLeftover}%)` }), _jsx(Stat, { title: "Avg visual remaining", value: selectedSession.avgObservedPercent == null ? "—" : `${selectedSession.avgObservedPercent}%` })] }), _jsx("h3", { style: { marginTop: 22 }, children: "Every plate" }), _jsx(PlateRows, { rows: selectedSession.plates })] })] })] }) });
}
function Nav({ onHistory }) { return _jsxs("nav", { className: "nav", children: [_jsx("div", { className: "brand", children: "\uD83C\uDF7D\uFE0F PlateScan AI" }), _jsxs("div", { className: "navlinks", children: [_jsxs("button", { className: "btn btn-soft", onClick: () => location.reload(), children: [_jsx(RefreshCw, { size: 15 }), " New"] }), _jsxs("button", { className: "btn btn-soft", onClick: onHistory, children: [_jsx(History, { size: 15 }), " History"] })] })] }); }
function ResultCard({ analysis }) { return _jsxs("div", { className: "card", style: { padding: 22, marginTop: 16 }, children: [_jsx("h2", { children: analysis.plateDetected ? "Plate detected" : "No clear plate detected" }), _jsx("p", { className: "muted", children: analysis.note || "AI visual estimate." }), analysis.foods?.length ? analysis.foods.map((f, i) => _jsxs("div", { className: "result", children: [_jsxs("div", { children: [_jsxs("b", { children: [f.emoji, " ", f.name] }), _jsxs("div", { className: "muted small", children: ["Confidence ", Math.round(f.confidence * 100), "%"] })] }), _jsxs("div", { children: [_jsx("span", { className: "pill", children: f.remainingAmount }), f.estimatedCount != null && _jsxs("span", { className: "pill", children: [f.estimatedCount, " ", f.unit] }), f.remainingPercent != null && _jsxs("span", { className: "pill", children: ["~", f.remainingPercent, "%"] })] })] }, i)) : _jsx("div", { className: "empty", children: "No food items were confidently identified." })] }); }
function Stat({ title, value }) { return _jsxs("div", { className: "card metric", children: [_jsx("div", { className: "label", children: title }), _jsx("div", { className: "value", children: value })] }); }
function PlateList({ plates }) { if (!plates.length)
    return _jsx("div", { className: "empty", children: "No plates captured yet." }); return _jsx("div", { children: plates.map(p => _jsxs("div", { className: "result", children: [_jsxs("div", { children: [_jsxs("b", { children: ["Plate #", p.sequence] }), _jsx("div", { className: "muted small", children: new Date(p.captured_at).toLocaleTimeString() })] }), _jsx("div", { style: { textAlign: "right" }, children: p.foods.length ? p.foods.map((f, i) => _jsxs("div", { children: [f.emoji, " ", f.name, " ", _jsxs("span", { className: "pill", children: [f.remainingAmount, f.estimatedCount != null ? ` • ${f.estimatedCount} ${f.unit}` : "", f.remainingPercent != null ? ` • ~${f.remainingPercent}%` : ""] })] }, i)) : "No clear food" })] }, `${p.sequence}-${p.captured_at}`)) }); }
function PlateRows({ rows }) { const m = new Map(); rows.forEach(r => { if (!m.has(r.sequence))
    m.set(r.sequence, []); m.get(r.sequence).push(r); }); return _jsx("div", { children: [...m].map(([n, rs]) => _jsxs("div", { className: "result", children: [_jsxs("div", { children: [_jsxs("b", { children: ["Plate #", n] }), _jsx("div", { className: "muted small", children: new Date(rs[0].captured_at).toLocaleTimeString() })] }), _jsx("div", { style: { textAlign: "right" }, children: rs.filter(x => x.name).map((f, i) => _jsxs("div", { children: [f.emoji, " ", f.name, " ", _jsxs("span", { className: "pill", children: [f.remaining_amount, f.estimated_count != null ? ` • ${f.estimated_count} ${f.unit || ""}` : "", f.remaining_percent != null ? ` • ~${f.remaining_percent}%` : ""] })] }, i)) })] }, n)) }); }

export default function PlateScan(){return _jsx("div",{className:"platescan-root",children:_jsx(PlateScanApp,{})});}
