import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Rule } from "../../../engine/money/categories";
import { put } from "../../api";
import { investPath } from "../../simple";

// The words that sort spending into categories. The first rule that matches a description wins.
export function MoneyRules({ spaceId }: { spaceId: string }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [line, setLine] = useState<{ ok: boolean; text: string } | null>(null);
  const path = `${investPath(spaceId)}/money/rules`;
  useEffect(() => {
    void fetch(path)
      .then((r) => r.json())
      .then((x) => setRules(x as Rule[]))
      .catch(() => setLine({ ok: false, text: "Couldn't load the rules. Try again." }));
  }, [path]);
  if (!rules) return line ? <p className="err">{line.text}</p> : null;
  const edit = (i: number, patch: Partial<Rule>) => setRules(rules.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const save = async () => {
    const res = await put<Rule[]>(path, { rules });
    setLine(res.ok ? { ok: true, text: "Saved." } : { ok: false, text: res.error });
  };
  return (
    <section className="money-rules">
      <ul>
        {rules.map((r, i) => (
          <li key={i}>
            <input value={r.match} aria-label="Words to match" onChange={(e) => edit(i, { match: e.target.value })} />
            <span className="faint">→</span>
            <input value={r.category} aria-label="Category" onChange={(e) => edit(i, { category: e.target.value })} />
            <button className="icon-btn" aria-label={`Remove the rule for ${r.match || "this row"}`} onClick={() => setRules(rules.filter((_, n) => n !== i))}>
              <X />
            </button>
          </li>
        ))}
      </ul>
      <div className="money-rules-acts">
        <button className="btn" onClick={() => setRules([...rules, { match: "", category: "" }])}>
          <Plus />
          Add a rule
        </button>
        <button className="btn p" onClick={() => void save()}>
          Save rules
        </button>
        {line && <span className={line.ok ? "ok-line" : "err"}>{line.text}</span>}
      </div>
    </section>
  );
}
