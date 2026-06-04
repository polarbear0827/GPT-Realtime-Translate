package local.keynotelivetranslator;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final int RECORD_AUDIO_REQUEST = 101;
    private static final int PORT = 8787;

    private LocalServer localServer;
    private WebView webView;
    private TextView statusView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        statusView = new TextView(this);
        statusView.setText("Starting Keynote Live Translator...");
        statusView.setTextColor(0xfff4f1e8);
        statusView.setTextSize(16);
        statusView.setPadding(32, 32, 32, 32);
        statusView.setBackgroundColor(0xff111311);

        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        root.addView(statusView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);

        configureWebView();
        requestAudioPermissionIfNeeded();
        startLocalServer();
    }

    @Override
    protected void onDestroy() {
        if (localServer != null) {
            localServer.stop();
            localServer = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (hasRecordAudioPermission()) {
                        request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                    } else {
                        request.deny();
                        requestAudioPermissionIfNeeded();
                    }
                });
            }
        });
    }

    private void requestAudioPermissionIfNeeded() {
        if (!hasRecordAudioPermission()) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, RECORD_AUDIO_REQUEST);
        }
    }

    private boolean hasRecordAudioPermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void startLocalServer() {
        try {
            localServer = new LocalServer(this, PORT);
            localServer.start();
            webView.loadUrl("http://127.0.0.1:" + PORT + "/");
            statusView.setVisibility(View.GONE);
        } catch (Exception error) {
            statusView.setVisibility(View.VISIBLE);
            statusView.setText("Unable to start local server: " + error.getMessage());
        }
    }
}
