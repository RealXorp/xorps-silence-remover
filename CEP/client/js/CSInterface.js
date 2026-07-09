/*
 * Lightweight CSInterface implementation.
 *
 * Adobe ships an official CSInterface.js with the CEP SDK samples
 * (github.com/Adobe-CEP/CEP-Resources). For a production build you should
 * drop the official file in here unmodified. This minimal version
 * implements only what Xorp's Silence Remover needs: evalScript(), event
 * listeners, and host environment info, so the extension works even if
 * you don't want to pull the full Adobe SDK file in.
 */
function CSInterface() {}

CSInterface.prototype.getHostEnvironment = function () {
  try {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment());
  } catch (e) {
    return { appName: "PPRO", appVersion: "unknown" };
  }
};

CSInterface.prototype.evalScript = function (script, callback) {
  if (!window.__adobe_cep__) {
    console.error("CEP runtime not detected. Are you running inside Premiere Pro?");
    if (callback) callback("__CEP_MISSING__");
    return;
  }
  window.__adobe_cep__.evalScript(script, function (result) {
    if (callback) callback(result);
  });
};

CSInterface.prototype.addEventListener = function (type, listener) {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.addEventListener(type, listener);
  }
};

CSInterface.prototype.getSystemPath = function (pathType) {
  try {
    return window.__adobe_cep__.getSystemPath(pathType);
  } catch (e) {
    return "";
  }
};

CSInterface.prototype.closeExtension = function () {
  if (window.__adobe_cep__) window.__adobe_cep__.closeExtension();
};

CSInterface.SystemPath = {
  EXTENSION: "extension",
  USER_DATA: "userData"
};
