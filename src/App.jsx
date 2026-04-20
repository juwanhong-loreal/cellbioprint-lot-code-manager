import { useState, useEffect, useCallback, useRef } from "react";

// ─────────────────────────────────────────────────────────────
// CONFIG — fill these in before deploying
// ─────────────────────────────────────────────────────────────
const GH_OWNER  = "juwanhong-loreal";   // e.g. "loreal-ushub"
const GH_REPO   = "cellbioprint-lot-code-manager";          
const GH_FILE   = "lot_codes.json";          // path in repo
const GH_BRANCH = "main";
// App password — set a simple shared password for your team
const APP_PASS  = "loreal123";
// ─────────────────────────────────────────────────────────────

const APP_VERSION = "2.0.0";
const CARTRIDGE_TYPES = { "98":"Triplex (98)", "99":"Duplex (99)", "11":"QC (11)" };
const C = {
  blue:"#1F4E79", mid:"#2E75B6", light:"#BDD7EE",
  green:"#375623", red:"#C00000", gray:"#595959",
  bg:"#F0F4F8", panel:"#FFFFFF", alt:"#EBF3FB",
  purple:"#7B5EA7", border:"#C5D8EE",
};

// ── GitHub API ────────────────────────────────────────────────
// Token is entered at login and kept only in memory (never stored)
const gh = {
  headers: (tok) => ({
    "Authorization": `Bearer ${tok}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  }),

  async readFile(tok) {
    const r = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}?ref=${GH_BRANCH}`,
      { headers: gh.headers(tok) }
    );
    if (r.status === 404) return { lots: [], sha: null };
    if (!r.ok) throw new Error(`GitHub read failed: ${r.status}`);
    const meta = await r.json();
    const content = JSON.parse(atob(meta.content.replace(/\n/g, "")));
    return { lots: content, sha: meta.sha };
  },

  async writeFile(tok, sha, lots) {
    const body = {
      message: `Update lot_codes.json — ${new Date().toISOString()}`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(lots, null, 2)))),
      branch: GH_BRANCH,
      ...(sha ? { sha } : {}),
    };
    const r = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`,
      { method: "PUT", headers: gh.headers(tok), body: JSON.stringify(body) }
    );
    if (!r.ok) {
      const err = await r.json().catch(()=>({}));
      throw new Error(err.message || `GitHub write failed: ${r.status}`);
    }
    const data = await r.json();
    return data.content.sha;
  },

  async validateToken(tok) {
    const r = await fetch("https://api.github.com/user", { headers: gh.headers(tok) });
    if (!r.ok) throw new Error("Invalid token");
    return r.json();
  },
};

// ── Entry normalization ───────────────────────────────────────
function normalize(raw) {
  let lot_number, valid_until, calibration_data;
  if ("lot_number" in raw && "valid_until" in raw && "calibration_data" in raw) {
    lot_number = String(raw.lot_number ?? "").trim();
    valid_until = String(raw.valid_until ?? "").trim();
    calibration_data = String(raw.calibration_data ?? "").trim();
  } else if ("lot" in raw && "exp_date" in raw && "data" in raw) {
    lot_number = String(raw.lot ?? "").trim();
    calibration_data = String(raw.data ?? "").trim();
    const d = new Date(raw.exp_date);
    if (isNaN(d)) throw new Error(`Invalid exp_date: ${raw.exp_date}`);
    valid_until = d.toISOString();
  } else {
    throw new Error("Missing required fields (lot/lot_number, exp_date/valid_until, data/calibration_data)");
  }
  const cartridge_number = String(raw.cartridge_number ?? "").trim();
  const revision_number  = parseInt(raw.revision_number ?? 0, 10);
  if (!cartridge_number) throw new Error("cartridge_number is empty");
  if (!lot_number)       throw new Error("lot_number is empty");
  if (!valid_until)      throw new Error("valid_until is empty");
  if (!calibration_data) throw new Error("calibration_data is empty");
  return { cartridge_number, lot_number, valid_until, revision_number, calibration_data };
}

function checkRevision(existing, incoming) {
  if (!existing) return "new";
  if (incoming.revision_number > existing.revision_number) return "upgrade";
  if (incoming.revision_number === existing.revision_number) return "same";
  return "older";
}

// ── UI atoms ──────────────────────────────────────────────────
const Btn = ({label, onClick, color=C.mid, disabled, style={}}) => (
  <button onClick={onClick} disabled={disabled} style={{
    background: disabled ? "#bbb" : color,
    color:"#fff", border:"none", borderRadius:6,
    padding:"9px 16px", fontSize:13, fontWeight:600,
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace:"nowrap", transition:"opacity .15s",
    opacity: disabled ? .7 : 1, ...style,
  }}>{label}</button>
);

function Toast({msg, type, onDone}) {
  useEffect(() => { const t = setTimeout(onDone, 5000); return () => clearTimeout(t); });
  const bg = type==="error" ? "#fde8e8" : type==="warn" ? "#fef9e7" : "#e8f5e9";
  const bd = type==="error" ? C.red : type==="warn" ? "#c8a000" : C.green;
  return (
    <div onClick={onDone} style={{
      position:"fixed", bottom:24, right:24, zIndex:999,
      background:bg, border:`1.5px solid ${bd}`, borderRadius:8,
      padding:"12px 18px", maxWidth:440, boxShadow:"0 4px 16px rgba(0,0,0,.14)",
      fontSize:13, color:"#1a1a1a", lineHeight:1.6, whiteSpace:"pre-line", cursor:"pointer",
    }}>{msg}</div>
  );
}

// ── Login ─────────────────────────────────────────────────────
function Login({onLogin}) {
  const [pass, setPass]   = useState("");
  const [token, setToken] = useState("");
  const [err, setErr]     = useState("");
  const [busy, setBusy]   = useState(false);
  const [step, setStep]   = useState(1); // 1=password, 2=token

  const checkPass = () => {
    if (pass === APP_PASS) { setStep(2); setErr(""); }
    else setErr("Incorrect password.");
  };

  const checkToken = async () => {
    setErr(""); setBusy(true);
    try {
      const user = await gh.validateToken(token);
      onLogin({ token, ghUser: user.login });
    } catch { setErr("Invalid GitHub token. Check scopes (needs repo read/write)."); }
    finally { setBusy(false); }
  };

  const inputStyle = {
    width:"100%", padding:"9px 12px", borderRadius:6,
    border:`1.5px solid ${C.border}`, fontSize:14,
    boxSizing:"border-box", outline:"none", marginBottom:14,
  };

  return (
    <div style={{minHeight:"100vh", background:C.bg, display:"flex", alignItems:"center", justifyContent:"center"}}>
      <div style={{background:C.panel, borderRadius:12, padding:"40px 48px", width:400, boxShadow:"0 4px 24px rgba(0,0,0,.10)"}}>
        <div style={{textAlign:"center", marginBottom:28}}>
          <div style={{fontSize:12, color:C.gray, letterSpacing:1, textTransform:"uppercase", marginBottom:4}}>
            L'Oréal US Hub Engineering
          </div>
          <div style={{fontSize:22, fontWeight:700, color:C.blue}}>Cell BioPrint</div>
          <div style={{fontSize:15, color:C.mid, fontWeight:600}}>Lot Code Manager</div>
        </div>

        {step === 1 ? <>
          <label style={{fontSize:12, color:C.gray, fontWeight:600, display:"block", marginBottom:4}}>APP PASSWORD</label>
          <input type="password" value={pass} placeholder="Enter team password"
            onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==="Enter"&&checkPass()}
            style={inputStyle} />
          {err && <div style={{color:C.red, background:"#FFF0F0", border:`1px solid ${C.red}`,
            borderRadius:6, padding:"8px 12px", fontSize:13, marginBottom:14}}>{err}</div>}
          <Btn label="Continue" onClick={checkPass} color={C.blue} style={{width:"100%", padding:11, fontSize:15}} />
          <div style={{textAlign:"center", marginTop:14, fontSize:12, color:C.gray}}>
            Access is invite-only. Contact your L'Oréal team lead.
          </div>
        </> : <>
          <label style={{fontSize:12, color:C.gray, fontWeight:600, display:"block", marginBottom:4}}>
            GITHUB PERSONAL ACCESS TOKEN
          </label>
          <input type="password" value={token} placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            onChange={e=>setToken(e.target.value)} onKeyDown={e=>e.key==="Enter"&&checkToken()}
            style={inputStyle} />
          <div style={{fontSize:12, color:C.gray, marginBottom:14, lineHeight:1.5}}>
            Token needs <strong>repo</strong> scope (read + write).<br/>
            <a href="https://github.com/settings/tokens/new" target="_blank"
              style={{color:C.mid}}>Create one here →</a>
          </div>
          {err && <div style={{color:C.red, background:"#FFF0F0", border:`1px solid ${C.red}`,
            borderRadius:6, padding:"8px 12px", fontSize:13, marginBottom:14}}>{err}</div>}
          <Btn label={busy ? "Verifying…" : "Sign In"} onClick={checkToken} disabled={busy}
            color={C.blue} style={{width:"100%", padding:11, fontSize:15}} />
          <button onClick={()=>{setStep(1);setErr("");}} style={{
            marginTop:10, width:"100%", background:"none", border:"none",
            color:C.gray, fontSize:13, cursor:"pointer", textDecoration:"underline",
          }}>← Back</button>
        </>}
      </div>
    </div>
  );
}

// ── Main app ──────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null);
  const [lots, setLots]       = useState([]);
  const [sha, setSha]         = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [toast, setToast]     = useState(null);
  const [filter, setFilter]   = useState("all");
  const fileRef   = useRef();
  const importRef = useRef();

  const showToast = (msg, type="info") => setToast({msg, type});

  const loadLots = useCallback(async (tok) => {
    setLoading(true);
    try {
      const { lots: data, sha: s } = await gh.readFile(tok);
      setLots(data); setSha(s);
    } catch(e) { showToast("Failed to load: " + e.message, "error"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (session) loadLots(session.token); }, [session]);

  const handleLogin  = (s) => setSession(s);
  const handleLogout = () => { setSession(null); setLots([]); setSha(null); };

  // ── Merge + save to GitHub ────────────────────────────────
  const mergeAndSave = async (entries, source) => {
    setSaving(true);
    let added=0, upgraded=0, skipped=0, older=0;
    const errors = [];
    const updated = [...lots];

    for (let i=0; i<entries.length; i++) {
      let entry;
      try { entry = normalize(entries[i]); }
      catch(e) { errors.push(`Entry ${i+1} (${source}): ${e.message}`); continue; }

      const now = new Date().toISOString();
      const idx = updated.findIndex(
        r => r.cartridge_number===entry.cartridge_number && r.lot_number===entry.lot_number
      );
      const existing = idx >= 0 ? updated[idx] : null;
      const status   = checkRevision(existing, entry);

      if (status==="same")  { skipped++; continue; }
      if (status==="older") { older++;   continue; }

      const row = {
        ...entry,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };

      if (idx >= 0) { updated[idx] = row; upgraded++; }
      else          { updated.push(row);  added++;    }
    }

    // Sort
    updated.sort((a,b) =>
      a.cartridge_number.localeCompare(b.cartridge_number) ||
      a.lot_number.localeCompare(b.lot_number)
    );

    try {
      const newSha = await gh.writeFile(session.token, sha, updated);
      setLots(updated); setSha(newSha);
    } catch(e) {
      errors.push("GitHub write error: " + e.message);
    }

    setSaving(false);

    const parts = [];
    if (added)    parts.push(`✓ ${added} new lot code(s) added`);
    if (upgraded) parts.push(`↑ ${upgraded} updated to newer revision`);
    if (skipped)  parts.push(`— ${skipped} duplicate(s) skipped`);
    if (older)    parts.push(`— ${older} skipped (older revision)`);
    if (errors.length) parts.push(`✗ ${errors.length} error(s):\n${errors.map(e=>"  • "+e).join("\n")}`);

    showToast(parts.join("\n") || "No changes made.", errors.length ? "error" : added||upgraded ? "info" : "warn");
  };

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files); e.target.value="";
    for (const file of files) {
      let raw;
      try { raw = JSON.parse(await file.text()); }
      catch { showToast(`${file.name}: invalid JSON`, "error"); continue; }
      await mergeAndSave(Array.isArray(raw) ? raw : [raw], file.name);
    }
  };

  const handleImport = async (e) => {
    const file = e.target.files[0]; e.target.value="";
    if (!file) return;
    let raw;
    try { raw = JSON.parse(await file.text()); }
    catch { showToast("Invalid JSON.", "error"); return; }
    if (!Array.isArray(raw)) { showToast("Expected a JSON array.", "error"); return; }
    await mergeAndSave(raw, file.name);
  };

  const handleExport = () => {
    if (!lots.length) { showToast("Nothing to export yet.", "warn"); return; }
    const blob = new Blob([JSON.stringify(lots, null, 2)], {type:"application/json"});
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: `lot_codes_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.json`,
    });
    a.click(); URL.revokeObjectURL(a.href);
    showToast(`✓ ${lots.length} lot code(s) exported.`);
  };

  // ── Filter ────────────────────────────────────────────────
  const now = new Date();
  const filtered = lots.filter(r => {
    if (filter==="all")     return true;
    if (filter==="expired") return new Date(r.valid_until) < now;
    if (filter==="active")  return new Date(r.valid_until) >= now;
    return r.cartridge_number === filter;
  });

  if (!session) return <Login onLogin={handleLogin} />;

  const busy = loading || saving;

  return (
    <div style={{minHeight:"100vh", background:C.bg, fontFamily:"Arial, sans-serif"}}>
      {/* Top bar */}
      <div style={{background:C.blue, height:52, display:"flex", alignItems:"center",
        justifyContent:"space-between", padding:"0 20px"}}>
        <span style={{color:"#fff", fontWeight:700, fontSize:16}}>
          Cell BioPrint &nbsp;|&nbsp; Lot Code Manager
        </span>
        <div style={{display:"flex", alignItems:"center", gap:14}}>
          {saving && <span style={{color:C.light, fontSize:12}}>Saving to GitHub…</span>}
          <span style={{color:C.light, fontSize:12}}>@{session.ghUser}</span>
          <span style={{color:C.light, fontSize:12}}>v{APP_VERSION}</span>
          <button onClick={handleLogout} style={{
            background:"transparent", border:`1px solid ${C.light}`,
            color:C.light, borderRadius:5, padding:"4px 10px", fontSize:12, cursor:"pointer",
          }}>Sign out</button>
        </div>
      </div>

      <div style={{padding:"16px 20px"}}>
        {/* Action bar */}
        <div style={{background:C.panel, borderRadius:8, padding:"12px 16px",
          display:"flex", alignItems:"center", gap:10, flexWrap:"wrap", marginBottom:14}}>
          <input ref={fileRef} type="file" accept=".json" multiple style={{display:"none"}} onChange={handleUpload} />
          <Btn label="＋ Upload Lot Code JSON" onClick={()=>fileRef.current.click()} color={C.mid} disabled={busy} />

          <input ref={importRef} type="file" accept=".json" style={{display:"none"}} onChange={handleImport} />
          <Btn label="⟳ Import Concatenated JSON" onClick={()=>importRef.current.click()} color={C.purple} disabled={busy} />

          <Btn label="↓ Export Concatenated JSON" onClick={handleExport} color={C.green} disabled={busy} />

          <div style={{marginLeft:"auto", display:"flex", alignItems:"center", gap:8}}>
            <select value={filter} onChange={e=>setFilter(e.target.value)} style={{
              border:`1.5px solid ${C.border}`, borderRadius:6,
              padding:"6px 10px", fontSize:13, color:C.gray, background:"#fff", cursor:"pointer",
            }}>
              <option value="all">All types</option>
              <option value="98">Triplex (98)</option>
              <option value="99">Duplex (99)</option>
              <option value="11">QC (11)</option>
              <option value="active">Active only</option>
              <option value="expired">Expired only</option>
            </select>
            <span style={{fontSize:13, color:C.gray, whiteSpace:"nowrap"}}>
              {loading ? "Loading…" : `${filtered.length} lot code${filtered.length!==1?"s":""}`}
            </span>
          </div>
        </div>

        {/* Table */}
        <div style={{background:C.panel, borderRadius:8, overflow:"hidden"}}>
          <div style={{background:C.blue, display:"grid",
            gridTemplateColumns:"44px 90px 150px 130px 130px 70px 1fr",
            padding:"0 10px", height:36, alignItems:"center"}}>
            {["#","Cartridge","Type","Lot Number","Valid Until","Rev","Added At"].map((h,i)=>(
              <span key={i} style={{color:"#fff", fontSize:12, fontWeight:700, paddingLeft:i===0?2:6}}>{h}</span>
            ))}
          </div>

          <div style={{maxHeight:"calc(100vh - 230px)", overflowY:"auto"}}>
            {filtered.length===0 ? (
              <div style={{padding:"40px 0", textAlign:"center", color:C.gray, fontSize:13}}>
                {loading ? "Loading…" : "No lot codes yet. Upload a JSON file to get started."}
              </div>
            ) : filtered.map((r,i) => {
              const exp    = new Date(r.valid_until);
              const isExp  = exp < now;
              const expStr = isNaN(exp) ? r.valid_until : exp.toISOString().slice(0,10);
              const addedStr = r.created_at
                ? new Date(r.created_at).toISOString().replace("T"," ").slice(0,16)+" UTC"
                : "—";
              return (
                <div key={i} style={{
                  display:"grid",
                  gridTemplateColumns:"44px 90px 150px 130px 130px 70px 1fr",
                  padding:"0 10px", height:32, alignItems:"center",
                  background: i%2===0 ? C.panel : C.alt,
                  borderBottom:"1px solid #E8EEF5",
                }}>
                  {[
                    {val:i+1,                                      color:C.gray},
                    {val:r.cartridge_number,                       color:"#1a1a1a"},
                    {val:CARTRIDGE_TYPES[r.cartridge_number]??`Unknown (${r.cartridge_number})`, color:"#1a1a1a"},
                    {val:r.lot_number,                             color:"#1a1a1a"},
                    {val:expStr,   color:isExp?C.red:"#1a1a1a",   bold:isExp},
                    {val:r.revision_number,                        color:"#1a1a1a"},
                    {val:addedStr,                                  color:C.gray},
                  ].map((cell,ci)=>(
                    <span key={ci} style={{
                      fontSize:12, color:cell.color, fontWeight:cell.bold?700:400,
                      paddingLeft:ci===0?2:6, overflow:"hidden",
                      textOverflow:"ellipsis", whiteSpace:"nowrap",
                    }}>{cell.val}</span>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={()=>setToast(null)} />}
    </div>
  );
}
