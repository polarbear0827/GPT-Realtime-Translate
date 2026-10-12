package local.keynotelivetranslator;

import android.webkit.JavascriptInterface;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * window.KltAndroid — the page's only way to reach native code. Methods run on WebView's binder
 * thread; network work moves to an executor and replies through MainActivity.resolve().
 * Calls are ignored unless the WebView is showing our own bundled page.
 */
public final class NativeBridge {
    private final MainActivity activity;
    private final RealtimeBackend backend;
    private final String version;
    private final ExecutorService executor = Executors.newFixedThreadPool(3);

    NativeBridge(MainActivity activity, RealtimeBackend backend, String version) {
        this.activity = activity;
        this.backend = backend;
        this.version = version;
    }

    @JavascriptInterface
    public String info() {
        try {
            return new JSONObject()
                .put("platform", "android")
                .put("version", version)
                .put("supports", new JSONObject()
                    .put("rememberKey", true)
                    .put("nativeSave", true)
                    .put("displayWindow", false))
                .put("rememberKeyLabel", "記住金鑰（以 Android Keystore 加密保存）")
                .toString();
        } catch (JSONException exception) {
            return "{}";
        }
    }

    @JavascriptInterface
    public void request(String callbackId, String requestJson) {
        if (!activity.isTrustedPage()) {
            activity.resolve(callbackId, "{\"status\":403,\"data\":{\"error\":\"Forbidden.\"}}");
            return;
        }
        executor.execute(() -> {
            String reply;
            try {
                JSONObject request = new JSONObject(requestJson);
                JSONObject body = request.optJSONObject("body");
                RealtimeBackend.Response response = backend.handle(
                    request.optString("method", "GET"),
                    request.optString("path", ""),
                    body == null ? new JSONObject() : body
                );
                reply = new JSONObject().put("status", response.status).put("data", response.data).toString();
            } catch (JSONException exception) {
                reply = "{\"status\":400,\"data\":{\"error\":\"Bad request.\"}}";
            }
            activity.resolve(callbackId, reply);
        });
    }

    @JavascriptInterface
    public void saveFile(String callbackId, String filename, String mimeType, String content) {
        if (!activity.isTrustedPage()) {
            activity.resolve(callbackId, "{\"saved\":false,\"error\":\"Forbidden.\"}");
            return;
        }
        activity.runOnUiThread(() -> activity.saveFile(callbackId, filename, mimeType, content));
    }

    @JavascriptInterface
    public void setKeepAwake(boolean enabled) {
        activity.runOnUiThread(() -> activity.setKeepAwake(enabled));
    }

    @JavascriptInterface
    public void setFullscreen(boolean enabled) {
        activity.runOnUiThread(() -> activity.setImmersive(enabled));
    }

    @JavascriptInterface
    public void setLeaveGuard(boolean enabled, String message) {
        activity.setLeaveGuard(enabled, message);
    }

    void shutdown() {
        executor.shutdownNow();
    }
}
