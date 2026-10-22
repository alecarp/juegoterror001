/* ==========================================================
   La biblioteca olvidada — sistema de audio OPTIMIZADO
   API pública idéntica: initAudio, playSound, audioCtxRef, ambientRef
   Optimizaciones:
   - Pool de buffers pre-generados (no alloc en playSound)
   - disconnect() en onended (evita leak)
   - resume() si el contexto está suspended
   - cache de ruido, tamaño limitado
   - LFOs y drones reutilizados
   ========================================================== */

const audioCtxRef   = { current: null };
const masterGainRef = { current: null };
const dronesRef     = { current: [] };
const ambientRef    = { current: null };
const subDroneRef   = { current: null };

// Cache de buffers para no generar en cada pisada/susto
const bufferCache = new Map();
function getOrCreateBuffer(ctx, key, durationSec, fillFn) {
  if (bufferCache.has(key)) return bufferCache.get(key);
  const len = Math.floor(ctx.sampleRate * durationSec);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  fillFn(data, len);
  bufferCache.set(key, buf);
  return buf;
}

async function initAudio() {
  if (audioCtxRef.current) {
    if (audioCtxRef.current.state === 'suspended') await audioCtxRef.current.resume();
    return;
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtxRef.current = ctx;

  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.7;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24; comp.knee.value = 30; comp.ratio.value = 12;
  comp.attack.value = 0.003; comp.release.value = 0.25;
  masterGain.connect(comp).connect(ctx.destination);
  masterGainRef.current = masterGain;

  // Drone grave - solo 1, con LFO
  const createDrone = (freq) => {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth"; osc.frequency.value = freq;
    const gain = ctx.createGain(); gain.gain.value = 0.06;
    const filt = ctx.createBiquadFilter(); filt.type = "lowpass"; filt.frequency.value = 380; filt.Q.value = 1;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 80;
    lfo.connect(lfoGain).connect(filt.frequency);
    osc.connect(filt).connect(gain).connect(masterGain);
    osc.start(); lfo.start();
    return { osc, lfo, gain, filt };
  };
  dronesRef.current = [createDrone(55)];

  // Ruido ambiente pre-generado 2s - cacheado
  const ambientBuf = getOrCreateBuffer(ctx, 'ambient_2s', 2, (d) => { for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1; });
  const src = ctx.createBufferSource(); src.buffer = ambientBuf; src.loop = true;
  const band = ctx.createBiquadFilter(); band.type="bandpass"; band.frequency.value=750; band.Q.value=0.8;
  const ambGain = ctx.createGain(); ambGain.gain.value=0.05;
  const lfo2 = ctx.createOscillator(); lfo2.frequency.value=0.11;
  const lfoGain2 = ctx.createGain(); lfoGain2.gain.value=0.03;
  lfo2.connect(lfoGain2).connect(ambGain.gain);
  src.connect(band).connect(ambGain).connect(masterGain);
  src.start(); lfo2.start();
  ambientRef.current = { gain: ambGain, filter: band };

  // Sub-grave opcional
  try {
    const osc = ctx.createOscillator(); osc.type="sawtooth"; osc.frequency.value=55;
    const filt = ctx.createBiquadFilter(); filt.type="lowpass"; filt.frequency.value=180; filt.Q.value=1;
    const gain = ctx.createGain(); gain.gain.value=0;
    const lfo = ctx.createOscillator(); lfo.frequency.value=0.32;
    const lg = ctx.createGain(); lg.gain.value=10;
    lfo.connect(lg).connect(osc.frequency);
    osc.connect(filt).connect(gain).connect(masterGain);
    osc.start(); lfo.start();
    subDroneRef.current = { osc, gain, filter: filt };
  } catch {}

  // Pre-cache buffers de efectos frecuentes
  getOrCreateBuffer(ctx, 'footstep_0.12', 0.12, (d,len)=>{ for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*Math.sin(Math.PI*i/len)*0.8; });
  getOrCreateBuffer(ctx, 'whisper_1.2', 1.2, (d,len)=>{ for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*0.5*Math.sin(Math.PI*i/len); });
  getOrCreateBuffer(ctx, 'claw_0.25', 0.25, (d,len)=>{ for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/len,1.2); });

  // Sonidos aleatorios - con buffers reutilizados, no nuevos cada vez
  const randomLoop = () => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    if (Math.random() > 0.5) {
      // tick metálico - oscilador corto, sin buffer
      const o = ctx.createOscillator(); o.frequency.value=1200+Math.random()*400;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.18, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.35);
      o.connect(g).connect(masterGain); o.start(); o.stop(ctx.currentTime+0.4);
      o.onended = () => { o.disconnect(); g.disconnect(); };
    } else {
      const len = Math.floor(ctx.sampleRate*0.6);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for(let i=0;i<len;i++) ch[i]=(Math.random()*2-1)*Math.pow(1-i/len,2.2);
      const src2 = ctx.createBufferSource(); src2.buffer=buf;
      const f = ctx.createBiquadFilter(); f.type="lowpass"; f.frequency.value=600+Math.random()*400;
      const g = ctx.createGain(); g.gain.value=0.22;
      src2.connect(f).connect(g).connect(masterGain); src2.start();
      src2.onended = () => { src2.disconnect(); f.disconnect(); g.disconnect(); };
    }
    setTimeout(randomLoop, 8000 + Math.random()*4000);
  };
  randomLoop();
}

function safeConnectAndAutoDisconnect(...nodes) {
  // Conecta en cadena y programa disconnect en onended del source
  for(let i=0;i<nodes.length-1;i++) nodes[i].connect(nodes[i+1]);
  const first = nodes[0];
  const lastGain = nodes[nodes.length-2];
  if (first.onended !== undefined) {
    first.onended = () => { nodes.forEach(n=>{ try{n.disconnect();}catch{} }); };
  }
  return first;
}

function playSound(name) {
  const ctx = audioCtxRef.current;
  const master = masterGainRef.current;
  if (!ctx || !master) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime;

  const cleanup = (src, ...others) => {
    const fn = () => { try{src.disconnect();}catch{} others.forEach(n=>{try{n.disconnect();}catch{}}); };
    if (src) { src.onended = fn; } else setTimeout(fn, 2000);
  };

  if (name === "pickup") {
    const o1 = ctx.createOscillator(); o1.frequency.setValueAtTime(220,t); o1.frequency.exponentialRampToValueAtTime(880,t+0.4);
    const g1 = ctx.createGain(); g1.gain.setValueAtTime(0.4,t); g1.gain.exponentialRampToValueAtTime(0.001,t+0.8);
    o1.connect(g1).connect(master); o1.start(); o1.stop(t+0.9); cleanup(o1,g1);
    const o2 = ctx.createOscillator(); o2.frequency.value=1760;
    const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.12,t); g2.gain.exponentialRampToValueAtTime(0.001,t+0.5);
    o2.connect(g2).connect(master); o2.start(); o2.stop(t+0.6); cleanup(o2,g2);
  } else if (name === "footstep") {
    const buf = bufferCache.get('footstep_0.12') || getOrCreateBuffer(ctx,'footstep_0.12',0.12,(d,l)=>{for(let i=0;i<l;i++) d[i]=(Math.random()*2-1)*Math.sin(Math.PI*i/l)*0.8;});
    const src = ctx.createBufferSource(); src.buffer=buf;
    const f = ctx.createBiquadFilter(); f.type="lowpass"; f.frequency.value=180;
    const g = ctx.createGain(); g.gain.value=0.22;
    src.connect(f).connect(g).connect(master); src.start(); cleanup(src,f,g);
  } else if (name === "heartbeat") {
    const o = ctx.createOscillator(); o.frequency.value=45;
    const g = ctx.createGain(); g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(0.6,t+0.05); g.gain.exponentialRampToValueAtTime(0.001,t+0.35);
    o.connect(g).connect(master); o.start(); o.stop(t+0.4); cleanup(o,g);
  } else if (name === "door") {
    const o = ctx.createOscillator(); o.type="sawtooth"; o.frequency.setValueAtTime(80,t); o.frequency.linearRampToValueAtTime(20,t+2.2);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.5,t); g.gain.linearRampToValueAtTime(0,t+2.5);
    o.connect(g).connect(master); o.start(); o.stop(t+2.6); cleanup(o,g);
  } else if (name === "scare") {
    for(let i=0;i<3;i++){
      const o = ctx.createOscillator(); o.type="sawtooth"; o.frequency.value=150+i*7+Math.random()*20;
      const g = ctx.createGain(); g.gain.setValueAtTime(0,t+i*0.05); g.gain.linearRampToValueAtTime(0.5-i*0.1,t+i*0.05+0.1); g.gain.exponentialRampToValueAtTime(0.001,t+1.2);
      o.connect(g).connect(master); o.start(t+i*0.05); o.stop(t+1.3); cleanup(o,g);
    }
  } else if (name === "flicker") {
    const o = ctx.createOscillator(); o.frequency.value=120;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.3,t); g.gain.linearRampToValueAtTime(0,t+0.15);
    o.connect(g).connect(master); o.start(); o.stop(t+0.16); cleanup(o,g);
  } else if (name === "whisper") {
    const buf = bufferCache.get('whisper_1.2') || getOrCreateBuffer(ctx,'whisper_1.2',1.2,(d,l)=>{for(let i=0;i<l;i++) d[i]=(Math.random()*2-1)*0.5*Math.sin(Math.PI*i/l);});
    const src = ctx.createBufferSource(); src.buffer=buf;
    const f = ctx.createBiquadFilter(); f.type="bandpass"; f.frequency.value=1800; f.Q.value=5;
    const g = ctx.createGain(); g.gain.value=0.12;
    src.connect(f).connect(g).connect(master); src.start(); cleanup(src,f,g);
  } else if (name === "growl") {
    const o = ctx.createOscillator(); o.type="sawtooth"; o.frequency.setValueAtTime(65,t); o.frequency.linearRampToValueAtTime(40,t+0.6);
    const f = ctx.createBiquadFilter(); f.type="lowpass"; f.frequency.value=280;
    const g = ctx.createGain(); g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(0.35,t+0.08); g.gain.exponentialRampToValueAtTime(0.001,t+0.9);
    o.connect(f).connect(g).connect(master); o.start(); o.stop(t+1); cleanup(o,f,g);
    const o2 = ctx.createOscillator(); o2.frequency.value=120;
    const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.18,t); g2.gain.exponentialRampToValueAtTime(0.001,t+0.5);
    o2.connect(g2).connect(master); o2.start(); o2.stop(t+0.6); cleanup(o2,g2);
  } else if (name === "claw") {
    const buf = bufferCache.get('claw_0.25') || getOrCreateBuffer(ctx,'claw_0.25',0.25,(d,l)=>{for(let i=0;i<l;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/l,1.2);});
    const src = ctx.createBufferSource(); src.buffer=buf;
    const hp = ctx.createBiquadFilter(); hp.type="highpass"; hp.frequency.value=2600;
    const bp = ctx.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=3200; bp.Q.value=2.5;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.28,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.3);
    src.connect(hp).connect(bp).connect(g).connect(master); src.start(); cleanup(src,hp,bp,g);
  } else if (name === "screech") {
    for(let i=0;i<2;i++){
      const o = ctx.createOscillator(); o.type="sawtooth"; o.frequency.setValueAtTime(300+i*120,t+i*0.08); o.frequency.exponentialRampToValueAtTime(1100+i*200,t+0.7+i*0.08);
      const g = ctx.createGain(); g.gain.setValueAtTime(0,t+i*0.08); g.gain.linearRampToValueAtTime(0.45-i*0.1,t+i*0.08+0.15); g.gain.exponentialRampToValueAtTime(0.001,t+1.1);
      o.connect(g).connect(master); o.start(t+i*0.08); o.stop(t+1.2); cleanup(o,g);
    }
  }
}

// Export para ESM y fallback global
if (typeof window !== 'undefined') {
  window.audioCtxRef = audioCtxRef;
  window.masterGainRef = masterGainRef;
  window.dronesRef = dronesRef;
  window.ambientRef = ambientRef;
  window.subDroneRef = subDroneRef;
  window.initAudio = initAudio;
  window.playSound = playSound;
}
export { audioCtxRef, masterGainRef, dronesRef, ambientRef, subDroneRef, initAudio, playSound };
