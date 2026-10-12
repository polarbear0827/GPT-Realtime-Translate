package local.keynotelivetranslator;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Hosts the web UI. Pages are served in-process from the APK assets under
 * https://appassets.androidplatform.net (a secure context, never resolved on the network), so the app
 * opens no local port that other apps could reach. API calls go through NativeBridge.
 */
public final class MainActivity extends Activity {
    static final String APP_HOST = "appassets.androidplatform.net";
    static final String APP_ORIGIN = "https://" + APP_HOST;
    private static final int RECORD_AUDIO_REQUEST = 101;
    private static final int SAVE_FILE_REQUEST = 102;
    private static final int BACKGROUND = 0xff111311;

    private FrameLayout root;
    private WebView webView;
    private RealtimeBackend backend;
    private NativeBridge bridge;
    private volatile String currentUrl = "";
    private volatile boolean leaveGuard;
    private volatile String leaveMessage = "";
    private boolean immersive;
    private PermissionRequest pendingPermission;
    private String pendingSaveCallback;
    private String pendingSaveContent;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 30) {
            // Draw edge-to-edge on every version and pad for system bars / cutouts / keyboard ourselves
            // (Android 15 enforces edge-to-edge for targetSdk 35).
            getWindow().setDecorFitsSystemWindows(false);
        }
        root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);
        setContentView(root);
        applyWindowInsets();

        String version = versionName();
        try {
            backend = new RealtimeBackend(this, version);
        } catch (Exception exception) {
            showFatalError("無法載入 App 設定：" + exception.getMessage());
            return;
        }
        bridge = new NativeBridge(this, backend, version);
        createWebView();
        if (!hasRecordAudioPermission()) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, RECORD_AUDIO_REQUEST);
        }
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.shutdown();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (immersive && webView != null) {
            webView.evaluateJavascript("document.getElementById('exitPresentBtn')?.click()", null);
            return;
        }
        if (!leaveGuard) {
            super.onBackPressed();
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle(leaveMessage.isEmpty() ? "確定要離開嗎？" : leaveMessage)
            .setMessage("離開後，尚未匯出的逐字稿可能會遺失。")
            .setNegativeButton("取消", null)
            .setPositiveButton("仍要離開", (dialog, which) -> finish())
            .show();
    }

    // ---- WebView ---------------------------------------------------------------------------------

    private void createWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(BACKGROUND);
        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        webView.addJavascriptInterface(bridge, "KltAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!"https".equals(url.getScheme()) || !APP_HOST.equals(url.getHost())) return null;
                return serveAsset(url.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("https".equals(url.getScheme()) && APP_HOST.equals(url.getHost())) return false;
                if ("https".equals(url.getScheme()) && request.hasGesture()) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, url));
                    } catch (ActivityNotFoundException ignored) {
                        // No browser installed.
                    }
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                currentUrl = url == null ? "" : url;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The renderer crashed or was killed: rebuild the WebView. The page offers to restore
                // the auto-backed-up transcript after it reloads.
                root.removeView(webView);
                webView.destroy();
                createWebView();
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handlePermissionRequest(request));
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("確定", (dialog, which) -> result.confirm())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("確定", (dialog, which) -> result.confirm())
                    .setNegativeButton("取消", (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
                return true;
            }
        });

        webView.loadUrl(APP_ORIGIN + "/index.html");
    }

    private WebResourceResponse serveAsset(String path) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Referrer-Policy", "no-referrer");
        String assetPath = path == null || path.isEmpty() || "/".equals(path) ? "index.html" : path.substring(1);
        if (assetPath.contains("..")) {
            return textResponse(403, "Forbidden", headers);
        }
        try {
            InputStream stream = getAssets().open(assetPath);
            return new WebResourceResponse(mimeType(assetPath), "utf-8", 200, "OK", headers, stream);
        } catch (IOException missing) {
            return textResponse(404, "Not Found", headers);
        }
    }

    private static WebResourceResponse textResponse(int status, String reason, Map<String, String> headers) {
        byte[] body = reason.getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse("text/plain", "utf-8", status, reason, headers, new ByteArrayInputStream(body));
    }

    private static String mimeType(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    boolean isTrustedPage() {
        return currentUrl.startsWith(APP_ORIGIN + "/");
    }

    void resolve(String callbackId, String json) {
        runOnUiThread(() -> {
            if (webView == null) return;
            webView.evaluateJavascript(
                "window.__kltNativeResolve && window.__kltNativeResolve(" + JSONObject.quote(callbackId) + "," + JSONObject.quote(json) + ")",
                null
            );
        });
    }

    // ---- microphone ----------------------------------------------------------------------------

    private void handlePermissionRequest(PermissionRequest request) {
        Uri origin = request.getOrigin();
        boolean trusted = origin != null && APP_HOST.equals(origin.getHost());
        boolean wantsAudio = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) wantsAudio = true;
        }
        if (!trusted || !wantsAudio) {
            request.deny();
            return;
        }
        if (hasRecordAudioPermission()) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        } else {
            if (pendingPermission != null) pendingPermission.deny();
            pendingPermission = request;
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, RECORD_AUDIO_REQUEST);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != RECORD_AUDIO_REQUEST || pendingPermission == null) return;
        PermissionRequest request = pendingPermission;
        pendingPermission = null;
        if (hasRecordAudioPermission()) request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        else request.deny();
    }

    private boolean hasRecordAudioPermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    // ---- bridge actions ------------------------------------------------------------------------

    void saveFile(String callbackId, String filename, String mimeType, String content) {
        if (pendingSaveCallback != null) resolve(pendingSaveCallback, "{\"saved\":false,\"cancelled\":true}");
        pendingSaveCallback = callbackId;
        pendingSaveContent = content;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        // SRT has no widely known MIME type; a generic type keeps document providers from appending ".txt".
        String baseType = mimeType == null ? "" : mimeType.split(";")[0].trim();
        intent.setType(baseType.isEmpty() || baseType.contains("subrip") ? "application/octet-stream" : baseType);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        try {
            startActivityForResult(intent, SAVE_FILE_REQUEST);
        } catch (ActivityNotFoundException exception) {
            pendingSaveCallback = null;
            pendingSaveContent = null;
            resolve(callbackId, "{\"saved\":false,\"error\":\"找不到可以儲存檔案的 App。\"}");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != SAVE_FILE_REQUEST || pendingSaveCallback == null) return;
        String callbackId = pendingSaveCallback;
        String content = pendingSaveContent;
        pendingSaveCallback = null;
        pendingSaveContent = null;
        Uri uri = data == null ? null : data.getData();
        if (resultCode != RESULT_OK || uri == null) {
            resolve(callbackId, "{\"saved\":false,\"cancelled\":true}");
            return;
        }
        new Thread(() -> {
            String reply;
            try (OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new IOException("無法開啟檔案。");
                output.write(content.getBytes(StandardCharsets.UTF_8));
                reply = new JSONObject().put("saved", true).put("path", uri.getLastPathSegment()).toString();
            } catch (IOException | JSONException exception) {
                reply = "{\"saved\":false,\"error\":" + JSONObject.quote(String.valueOf(exception.getMessage())) + "}";
            }
            resolve(callbackId, reply);
        }).start();
    }

    void setKeepAwake(boolean enabled) {
        if (enabled) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    void setImmersive(boolean enabled) {
        immersive = enabled;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller == null) return;
            if (enabled) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            } else {
                controller.show(WindowInsets.Type.systemBars());
            }
        } else {
            View decor = getWindow().getDecorView();
            decor.setSystemUiVisibility(enabled
                ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                : View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    void setLeaveGuard(boolean enabled, String message) {
        leaveGuard = enabled;
        leaveMessage = message == null ? "" : message;
    }

    // ---- helpers -------------------------------------------------------------------------------

    private void applyWindowInsets() {
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime()
                );
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        }
    }

    private String versionName() {
        try {
            String name = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            return name == null ? "" : name;
        } catch (PackageManager.NameNotFoundException exception) {
            return "";
        }
    }

    private void showFatalError(String message) {
        TextView text = new TextView(this);
        text.setText(message);
        text.setTextColor(0xfff4f1e8);
        text.setTextSize(16);
        text.setPadding(48, 48, 48, 48);
        root.addView(text);
    }
}
