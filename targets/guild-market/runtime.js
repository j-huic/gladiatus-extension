// Standalone guild-market lifecycle runtime. It exits before touching storage
// on every page except the Guild Market.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const settingsApi = root.GladiatusGuildMarketSettings;
  const controller = root.GladiatusGuildMarketController;
  const href = root.location?.href || root.document?.location?.href || "";
  const relevant = Boolean(controller?.isGuildMarketUrl?.(href));
  const state = {
    relevant,
    started: false,
    enabled: false,
    stopped: false,
    lastError: "",
    settingsRevision: 0,
    unsubscribe: null,
    queue: Promise.resolve()
  };

  function status() {
    return {
      relevant: state.relevant,
      started: state.started,
      enabled: state.enabled,
      stopped: state.stopped,
      lastError: state.lastError,
      controller: controller?.getStatus?.() || null
    };
  }

  async function apply(settings) {
    if (state.stopped || !state.relevant) return false;
    const featureSettings = settingsApi.toFeatureSettings(settings);
    try {
      if (!featureSettings.enabled) {
        state.enabled = false;
        await controller.stop();
        state.lastError = "";
        return false;
      }
      const result = state.enabled
        ? await controller.update(featureSettings)
        : await controller.start(featureSettings);
      state.enabled = result !== false;
      state.lastError = "";
      return state.enabled;
    } catch (error) {
      state.enabled = false;
      state.lastError = error?.message || String(error);
      try {
        await controller.stop();
      } catch (_stopError) {
        // The local controller already removes its owned UI before reporting.
      }
      return false;
    }
  }

  function enqueue(settings) {
    state.queue = state.queue.then(() => apply(settings));
    return state.queue;
  }

  async function stop() {
    if (state.stopped) return true;
    state.stopped = true;
    state.enabled = false;
    state.unsubscribe?.();
    state.unsubscribe = null;
    await state.queue.catch(() => {});
    await controller?.stop?.();
    return true;
  }

  async function start() {
    if (!relevant || !settingsApi || !controller) return false;
    if (state.started) return state.queue;
    if (state.stopped) return false;
    state.started = true;
    state.unsubscribe = settingsApi.subscribe((settings) => {
      state.settingsRevision += 1;
      enqueue(settings);
    });
    const revisionBeforeRead = state.settingsRevision;
    let settings;
    try {
      settings = await settingsApi.get();
    } catch (error) {
      state.lastError = error?.message || String(error);
      return false;
    }
    if (state.stopped || state.settingsRevision !== revisionBeforeRead) return state.queue;
    return enqueue(settings);
  }

  const api = Object.freeze({ start, stop, getStatus: status });
  root.GladiatusGuildMarketRuntime = api;
  root.GladiatusGuildMarketRuntimeReady = start();
})();
