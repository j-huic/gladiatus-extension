(() => {
  const settingsApi = globalThis.GladiatusGuildMarketSettings;
  const enabledSwitch = document.getElementById("enabled-switch");
  const switchLabel = enabledSwitch.querySelector(".switch-label");
  const priceForm = document.getElementById("price-form");
  const unitPrice = document.getElementById("unit-price");
  const savePrice = document.getElementById("save-price");
  const status = document.getElementById("status");
  let settings = null;

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle("error", error);
  }

  function render(next) {
    settings = settingsApi.normalize(next);
    enabledSwitch.disabled = false;
    enabledSwitch.setAttribute("aria-checked", String(settings.enabled));
    switchLabel.textContent = settings.enabled ? "On" : "Off";
    unitPrice.value = String(settings.pricePerUnit);
    unitPrice.disabled = !settings.enabled;
    savePrice.disabled = !settings.enabled;
  }

  enabledSwitch.addEventListener("click", async () => {
    enabledSwitch.disabled = true;
    try {
      const next = await settingsApi.update({ enabled: !settings.enabled });
      render(next);
      setStatus(next.enabled
        ? "Enabled. Staged Mini-Pumpkins will be priced automatically."
        : "Disabled. The page helper has been removed.");
    } catch (error) {
      setStatus(error?.message || "The setting could not be saved.", true);
    } finally {
      enabledSwitch.disabled = false;
    }
  });

  priceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const price = Number(String(unitPrice.value || "").trim());
    if (!Number.isSafeInteger(price) || price <= 0) {
      unitPrice.setCustomValidity("Enter a positive whole-number price.");
      unitPrice.reportValidity();
      setStatus("Enter a positive whole-number price.", true);
      return;
    }
    unitPrice.setCustomValidity("");
    savePrice.disabled = true;
    try {
      const next = await settingsApi.update({ pricePerUnit: price });
      render(next);
      setStatus(`Saved ${new Intl.NumberFormat().format(next.pricePerUnit)} gold per Mini-Pumpkin.`);
    } catch (error) {
      setStatus(error?.message || "The price could not be saved.", true);
    } finally {
      savePrice.disabled = !settings?.enabled;
    }
  });

  unitPrice.addEventListener("input", () => {
    unitPrice.setCustomValidity("");
    if (status.classList.contains("error")) setStatus("");
  });
  settingsApi.subscribe(render);
  settingsApi.get().then(render).catch((error) => {
    setStatus(error?.message || "Settings could not be loaded.", true);
    enabledSwitch.disabled = true;
    unitPrice.disabled = true;
    savePrice.disabled = true;
  });
})();
