import { useState } from "react";
import type { Room } from "../../../engine/money/room";
import { put } from "../../api";

// TFSA room left this year and where the number comes from. Jan 1 room is typed in from CRA My Account.
export function MoneyRoom({ room }: { room: Room }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(room.roomJan1 === null ? "" : String(room.roomJan1));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const res = await put("/api/investing/tfsa/room", { year: room.year, roomJan1: Number(value.replace(/[$,\s]/g, "")) });
    if (res.ok) {
      setEditing(false);
      setError(null);
    } else setError(res.error);
  };
  return (
    <div className="money-room">
      <p className={`money-room-head${room.over > 0 ? " over" : ""}`}>{room.headline}</p>
      {room.from && <p className="faint">{room.from}</p>}
      {room.todo && <p className="hint">{room.todo}</p>}
      {editing ? (
        <form
          className="money-inline"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Room on Jan 1, {room.year}
            <input value={value} inputMode="decimal" placeholder="7000" autoFocus onChange={(e) => setValue(e.target.value)} />
          </label>
          <button className="btn p" type="submit" disabled={!value.trim()}>
            Save
          </button>
          <button className="btn link" type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="btn link" onClick={() => setEditing(true)}>
          {room.roomJan1 === null ? "Enter your room" : "Change Jan 1 room"}
        </button>
      )}
      {error && <p className="err">{error}</p>}
    </div>
  );
}
