// Loaded by the CLI before the app itself: chalk reads the environment once, as it loads. When Atrium has decided
// the terminal does truecolor, chalk is told so too, or it would round Atrium's hex colors down to the nearest of 256.
import { detectMode } from "./theme";

if (detectMode(process.env) === "truecolor" && process.env.FORCE_COLOR === undefined) process.env.FORCE_COLOR = "3";
