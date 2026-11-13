import { useEffect, useState } from "react";
import { put } from "../api";
import { navigate } from "../route";

type ProfileData = { name: string | null; suggestedName: string | null; projectsRoot: string };

// The few things that are about you: kept in Atrium's own data folder, never in the app's code.
export function Profile() {
  const [p, setP] = useState<ProfileData | null>(null);
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void fetch("/api/profile")
      .then((r) => r.json() as Promise<ProfileData>)
      .then((d) => {
        setP(d);
        setName(d.name ?? "");
        setRoot(d.projectsRoot);
      });
  }, []);
  if (!p) return <div className="list"><div className="empty-row">Loading…</div></div>;
  const save = async () => {
    const res = await put<ProfileData>("/api/profile", { name, projectsRoot: root });
    if (res.ok) {
      setP(res.data);
      setRoot(res.data.projectsRoot);
    }
    setMsg(res.ok ? { ok: true, text: "Saved." } : { ok: false, text: res.error });
  };
  return (
    <div className="set-card">
      <form
        className="mk-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          Your name
          <input value={name} placeholder={p.suggestedName ?? "Optional"} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Projects folder
          <input value={root} onChange={(e) => setRoot(e.target.value)} />
        </label>
        <button className="btn" type="submit">
          Save
        </button>
        {msg && <span className={`hint${msg.ok ? "" : " bad"}`}>{msg.text}</span>}
      </form>
      <button className="btn link" onClick={() => navigate("/start")}>
        Get started
      </button>
    </div>
  );
}
