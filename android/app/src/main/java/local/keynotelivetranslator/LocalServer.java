package local.keynotelivetranslator;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class LocalServer {
    private static final Set<String> TRANSLATION_OUTPUT_LANGUAGES = new HashSet<>(Arrays.asList(
        "es", "pt", "fr", "ja", "ru", "zh", "de", "ko", "hi", "id", "vi", "it", "en"
    ));
    private static final Set<String> TRANSCRIPTION_LANGUAGES = new HashSet<>(Arrays.asList("en", "zh"));

    private final Context context;
    private final int port;
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private volatile boolean running;
    private ServerSocket serverSocket;
    private String apiKey;

    LocalServer(Context context, int port) {
        this.context = context.getApplicationContext();
        this.port = port;
    }

    void start() throws IOException {
        if (running) return;
        serverSocket = new ServerSocket();
        serverSocket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
        running = true;
        Thread acceptThread = new Thread(this::acceptLoop, "klt-local-server");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
        workers.shutdownNow();
        apiKey = null;
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket socket = serverSocket.accept();
                workers.execute(() -> handleSocket(socket));
            } catch (IOException error) {
                if (running) {
                    error.printStackTrace();
                }
            }
        }
    }

    private void handleSocket(Socket socket) {
        try (Socket closeableSocket = socket) {
            socket.setSoTimeout(15000);
            HttpRequest request = readRequest(socket.getInputStream());
            if (request == null) return;
            HttpResponse response = route(request);
            writeResponse(socket.getOutputStream(), request.method, response);
        } catch (Exception error) {
            try {
                writeResponse(socket.getOutputStream(), "GET", json(500, "{\"error\":\"Internal server error.\"}"));
            } catch (Exception ignored) {
            }
        }
    }

    private HttpResponse route(HttpRequest request) throws Exception {
        if ("GET".equals(request.method) && "/api/health".equals(request.path)) {
            return json(200, "{\"ok\":true,\"version\":\"0.3.0\",\"hasApiKey\":" + (apiKey != null) + "}");
        }

        if ("POST".equals(request.method) && "/api/key".equals(request.path)) {
            JSONObject body = new JSONObject(request.bodyText());
            String key = body.optString("apiKey", "").trim();
            if (!key.startsWith("sk-") || key.length() < 20) {
                return json(400, "{\"error\":\"Invalid API key format.\"}");
            }
            apiKey = key;
            return json(200, "{\"ok\":true}");
        }

        if ("DELETE".equals(request.method) && "/api/key".equals(request.path)) {
            apiKey = null;
            return json(200, "{\"ok\":true}");
        }

        if ("POST".equals(request.method) && "/api/realtime/translation-client-secret".equals(request.path)) {
            if (apiKey == null) return json(401, "{\"error\":\"API key is not set.\"}");
            JSONObject body = new JSONObject(request.bodyText());
            String targetLanguage = body.optString("targetLanguage", "zh");
            if (!TRANSLATION_OUTPUT_LANGUAGES.contains(targetLanguage)) {
                return json(400, "{\"error\":\"Unsupported translation target language.\"}");
            }
            String safetyIdentifier = safeSafetyIdentifier(body.optString("safetyIdentifier", "local-android-user"));
            JSONObject payload = new JSONObject()
                .put("session", new JSONObject()
                    .put("model", "gpt-realtime-translate")
                    .put("audio", new JSONObject()
                        .put("input", new JSONObject()
                            .put("noise_reduction", new JSONObject().put("type", "near_field")))
                        .put("output", new JSONObject().put("language", targetLanguage))));
            return postOpenAi("https://api.openai.com/v1/realtime/translations/client_secrets", payload.toString(), safetyIdentifier);
        }

        if ("POST".equals(request.method) && "/api/realtime/transcription-client-secret".equals(request.path)) {
            if (apiKey == null) return json(401, "{\"error\":\"API key is not set.\"}");
            JSONObject body = new JSONObject(request.bodyText());
            String sourceLanguage = body.optString("sourceLanguage", "en");
            if (!TRANSCRIPTION_LANGUAGES.contains(sourceLanguage)) {
                return json(400, "{\"error\":\"Unsupported transcription source language.\"}");
            }
            String delay = body.optString("delay", "low");
            String safetyIdentifier = safeSafetyIdentifier(body.optString("safetyIdentifier", "local-android-user"));
            JSONObject payload = new JSONObject()
                .put("expires_after", new JSONObject()
                    .put("anchor", "created_at")
                    .put("seconds", 600))
                .put("session", new JSONObject()
                    .put("type", "transcription")
                    .put("audio", new JSONObject()
                        .put("input", new JSONObject()
                            .put("format", new JSONObject()
                                .put("type", "audio/pcm")
                                .put("rate", 24000))
                            .put("transcription", new JSONObject()
                                .put("model", "gpt-realtime-whisper")
                                .put("language", sourceLanguage)
                                .put("delay", delay))
                            .put("noise_reduction", new JSONObject().put("type", "near_field"))
                            .put("turn_detection", JSONObject.NULL))));
            return postOpenAi("https://api.openai.com/v1/realtime/client_secrets", payload.toString(), safetyIdentifier);
        }

        if ("GET".equals(request.method) || "HEAD".equals(request.method)) {
            return serveAsset(request.path);
        }

        return json(405, "{\"error\":\"Method not allowed.\"}");
    }

    private HttpResponse serveAsset(String path) throws IOException {
        String assetPath = path.equals("/") ? "index.html" : path.substring(1);
        if (assetPath.contains("..") || assetPath.startsWith("/")) {
            return json(403, "{\"error\":\"Forbidden.\"}");
        }
        try (InputStream stream = context.getAssets().open(assetPath)) {
            byte[] bytes = readAllBytes(stream);
            return new HttpResponse(200, contentType(assetPath), bytes);
        } catch (IOException missing) {
            try (InputStream stream = context.getAssets().open("index.html")) {
                return new HttpResponse(200, "text/html;charset=utf-8", readAllBytes(stream));
            }
        }
    }

    private HttpResponse postOpenAi(String endpoint, String body, String safetyIdentifier) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Authorization", "Bearer " + apiKey);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("OpenAI-Safety-Identifier", safetyIdentifier);
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(payload.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(payload);
        }
        int status = connection.getResponseCode();
        InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        byte[] response = input == null ? new byte[0] : readAllBytes(input);
        return new HttpResponse(status, "application/json;charset=utf-8", response);
    }

    private HttpRequest readRequest(InputStream input) throws IOException {
        byte[] headerBytes = readHeaderBytes(input);
        if (headerBytes.length == 0) return null;
        String headerText = new String(headerBytes, StandardCharsets.ISO_8859_1);
        String[] lines = headerText.split("\\r?\\n");
        if (lines.length == 0) return null;
        String[] requestLine = lines[0].split(" ");
        if (requestLine.length < 2) return null;

        Map<String, String> headers = new HashMap<>();
        for (int i = 1; i < lines.length; i += 1) {
            int index = lines[i].indexOf(':');
            if (index > 0) {
                headers.put(lines[i].substring(0, index).trim().toLowerCase(Locale.ROOT), lines[i].substring(index + 1).trim());
            }
        }

        int contentLength = 0;
        if (headers.containsKey("content-length")) {
            contentLength = Integer.parseInt(headers.get("content-length"));
        }
        byte[] body = new byte[contentLength];
        int offset = 0;
        while (offset < contentLength) {
            int read = input.read(body, offset, contentLength - offset);
            if (read < 0) break;
            offset += read;
        }

        String path = requestLine[1];
        int queryIndex = path.indexOf('?');
        if (queryIndex >= 0) path = path.substring(0, queryIndex);
        return new HttpRequest(requestLine[0], path, headers, body);
    }

    private byte[] readHeaderBytes(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int matched = 0;
        int value;
        byte[] terminator = new byte[] {'\r', '\n', '\r', '\n'};
        while ((value = input.read()) != -1) {
            output.write(value);
            if ((byte) value == terminator[matched]) {
                matched += 1;
                if (matched == terminator.length) break;
            } else {
                matched = 0;
            }
            if (output.size() > 32768) break;
        }
        return output.toByteArray();
    }

    private void writeResponse(OutputStream output, String method, HttpResponse response) throws IOException {
        byte[] header = (
            "HTTP/1.1 " + response.status + " OK\r\n" +
            "Content-Type: " + response.contentType + "\r\n" +
            "Content-Length: " + response.body.length + "\r\n" +
            "Connection: close\r\n" +
            "Cache-Control: no-store\r\n" +
            "X-Content-Type-Options: nosniff\r\n" +
            "\r\n"
        ).getBytes(StandardCharsets.UTF_8);
        output.write(header);
        if (!"HEAD".equals(method)) output.write(response.body);
        output.flush();
    }

    private static HttpResponse json(int status, String body) {
        return new HttpResponse(status, "application/json;charset=utf-8", body.getBytes(StandardCharsets.UTF_8));
    }

    private static String safeSafetyIdentifier(String value) {
        if (value == null || value.length() > 80 || value.isEmpty()) return "local-android-user";
        return value;
    }

    private static String contentType(String assetPath) {
        if (assetPath.endsWith(".html")) return "text/html;charset=utf-8";
        if (assetPath.endsWith(".css")) return "text/css;charset=utf-8";
        if (assetPath.endsWith(".js")) return "text/javascript;charset=utf-8";
        if (assetPath.endsWith(".json")) return "application/json;charset=utf-8";
        return "application/octet-stream";
    }

    private static byte[] readAllBytes(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static final class HttpRequest {
        final String method;
        final String path;
        final Map<String, String> headers;
        final byte[] body;

        HttpRequest(String method, String path, Map<String, String> headers, byte[] body) {
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
        }

        String bodyText() {
            return new String(body, StandardCharsets.UTF_8);
        }
    }

    private static final class HttpResponse {
        final int status;
        final String contentType;
        final byte[] body;

        HttpResponse(int status, String contentType, byte[] body) {
            this.status = status;
            this.contentType = contentType;
            this.body = body == null ? new byte[0] : body;
        }
    }
}
