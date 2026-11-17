// A browser DOM for the tests that drive real components with clicks and keys. Imported first, so React's DOM
// client sees `window` when it loads; `closeDom` removes it again so other files keep their DOM-free world.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

class InertSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

// A later file's import of this module is cached, so it calls this at its top level to get the DOM back after an
// earlier file closed it.
export function openDom(): void {
  if (GlobalRegistrator.isRegistered) return;
  GlobalRegistrator.register({ url: "http://127.0.0.1:7420/" });
  // The dashboard opens its live socket at location.host, which here is the engine's default port: a real socket would
  // reach a running Atrium and take its state pushes mid-test. Tests get one that never connects.
  (globalThis as { WebSocket: unknown }).WebSocket = InertSocket;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

openDom();

export const closeDom = () => GlobalRegistrator.unregister();
