package local.keynotelivetranslator;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * Native backend for the Android app. Mirrors server/realtime.mjs (validation + payloads) and
 * server/index.mjs (key handling, OpenAI calls). Requests arrive from the WebView through
 * NativeBridge on worker threads; no network port is opened on the device.
 */
final class RealtimeBackend {
    static final class Response {
        final int status;
        final Object data;

        Response(int status, Object data) {
            this.status = status;
            this.data = data;
        }
    }

    static final class BackendException extends Exception {
        final int status;

        BackendException(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    private static final String OPENAI = "https://api.openai.com/v1";

    private final JSONObject config;
    private final JSONObject limits;
    private final JSONObject defaults;
    private final SecureKeyStore keyStore;
    private final String version;
    private volatile String apiKey;
    private volatile boolean rememberedKey;

    RealtimeBackend(Context context, String version) throws IOException, JSONException {
        this.config = new JSONObject(readAsset(context, "realtime-config.json"));
        this.limits = config.getJSONObject("limits");
        this.defaults = config.getJSONObject("defaults");
        this.keyStore = new SecureKeyStore(context);
        this.version = version;
        String stored = keyStore.load();
        if (stored != null) {
            apiKey = stored;
            rememberedKey = true;
        }
    }

    Response handle(String method, String path, JSONObject body) {
        try {
            if ("GET".equals(method) && "/api/health".equals(path)) {
                return new Response(200, new JSONObject()
                    .put("ok", true)
                    .put("version", version)
                    .put("hasApiKey", apiKey != null)
                    .put("rememberedKey", rememberedKey));
            }
            if ("POST".equals(method) && "/api/key".equals(path)) {
                String key = validateApiKeyFormat(body.opt("apiKey"));
                JSONArray warnings = verifyKey(key);
                apiKey = key;
                if (body.optBoolean("remember", false)) {
                    rememberedKey = keyStore.save(key);
                } else {
                    keyStore.delete();
                    rememberedKey = false;
                }
                return new Response(200, new JSONObject()
                    .put("ok", true)
                    .put("remembered", rememberedKey)
                    .put("warnings", warnings));
            }
            if ("DELETE".equals(method) && "/api/key".equals(path)) {
                apiKey = null;
                rememberedKey = false;
                keyStore.delete();
                return new Response(200, new JSONObject().put("ok", true));
            }
            if ("POST".equals(method) && "/api/realtime/translation-client-secret".equals(path)) {
                String targetLanguage = stringOr(body.opt("targetLanguage"), defaults.getString("targetLanguage"));
                if (!contains("translationOutputLanguages", targetLanguage)) {
                    throw new BackendException(400, "不支援的翻譯目標語言。");
                }
                String noiseReduction = validateNoiseReduction(body.opt("noiseReduction"));
                return createClientSecret(OPENAI + "/realtime/translations/client_secrets",
                    translationSecretRequest(targetLanguage, noiseReduction));
            }
            if ("POST".equals(method) && "/api/realtime/transcription-client-secret".equals(path)) {
                return createClientSecret(OPENAI + "/realtime/client_secrets", transcriptionSecretRequest(body));
            }
            return new Response(404, error("Not found."));
        } catch (BackendException exception) {
            return new Response(exception.status, error(exception.getMessage()));
        } catch (Exception exception) {
            return new Response(500, error("Internal error."));
        }
    }

    // ---- validation & payloads (same rules as server/realtime.mjs) ----

    static String validateApiKeyFormat(Object value) throws BackendException {
        String key = value instanceof String ? ((String) value).trim() : "";
        if (!key.startsWith("sk-") || key.length() < 20 || key.matches("(?s).*\\s.*")) {
            throw new BackendException(400, "API key 格式不正確，應以 sk- 開頭。");
        }
        return key;
    }

    JSONObject translationSecretRequest(String targetLanguage, String noiseReduction) throws JSONException {
        return new JSONObject().put("session", new JSONObject()
            .put("model", config.getJSONObject("models").getString("translation"))
            .put("audio", new JSONObject()
                .put("input", new JSONObject().put("noise_reduction", new JSONObject().put("type", noiseReduction)))
                .put("output", new JSONObject().put("language", targetLanguage))));
    }

    JSONObject transcriptionSecretRequest(JSONObject body) throws JSONException, BackendException {
        String sourceLanguage = stringOr(body.opt("sourceLanguage"), defaults.getString("sourceLanguage"));
        if (!contains("transcriptionLanguages", sourceLanguage)) {
            throw new BackendException(400, "不支援的原文語言。");
        }
        String delay = stringOr(body.opt("delay"), defaults.getString("transcriptionDelay"));
        if (!contains("transcriptionDelays", delay)) {
            throw new BackendException(400, "不支援的轉錄延遲設定。");
        }
        String prompt = stringOr(body.opt("prompt"), "").trim();
        int promptMax = limits.getInt("promptMaxChars");
        if (prompt.length() > promptMax) {
            throw new BackendException(400, "情境說明最多 " + promptMax + " 個字。");
        }
        List<String> keywords = normalizeKeywords(body.opt("keywords"));
        String noiseReduction = validateNoiseReduction(body.opt("noiseReduction"));

        JSONObject transcription = new JSONObject()
            .put("model", config.getJSONObject("models").getString("transcription"))
            .put("languages", new JSONArray().put(sourceLanguage))
            .put("delay", delay);
        if (!prompt.isEmpty()) transcription.put("prompt", prompt);
        if (!keywords.isEmpty()) transcription.put("keywords", new JSONArray(keywords));

        return new JSONObject()
            .put("expires_after", new JSONObject()
                .put("anchor", "created_at")
                .put("seconds", config.getInt("clientSecretTtlSeconds")))
            .put("session", new JSONObject()
                .put("type", "transcription")
                .put("audio", new JSONObject()
                    .put("input", new JSONObject()
                        .put("format", new JSONObject().put("type", "audio/pcm").put("rate", 24000))
                        .put("transcription", transcription)
                        .put("noise_reduction", new JSONObject().put("type", noiseReduction))
                        .put("turn_detection", JSONObject.NULL))));
    }

    List<String> normalizeKeywords(Object input) throws BackendException, JSONException {
        List<Object> raw = new ArrayList<>();
        if (input instanceof JSONArray) {
            JSONArray array = (JSONArray) input;
            for (int index = 0; index < array.length(); index += 1) raw.add(array.opt(index));
        } else if (input instanceof String) {
            raw.addAll(Arrays.asList(((String) input).split("[\\n,，、]", -1)));
        }
        int maxChars = limits.getInt("keywordMaxChars");
        int maxCount = limits.getInt("keywordsMaxCount");
        Set<String> seen = new HashSet<>();
        List<String> keywords = new ArrayList<>();
        for (Object item : raw) {
            if (!(item instanceof String)) continue;
            String keyword = ((String) item).replaceAll("[<>\\r\\n]", " ").replaceAll("\\s+", " ").trim();
            String folded = keyword.toLowerCase(Locale.ROOT);
            if (keyword.isEmpty() || seen.contains(folded)) continue;
            if (keyword.length() > maxChars) {
                String preview = keyword.substring(0, Math.min(20, keyword.length()));
                throw new BackendException(400, "關鍵字「" + preview + "…」太長，每個最多 " + maxChars + " 字。");
            }
            seen.add(folded);
            keywords.add(keyword);
        }
        if (keywords.size() > maxCount) {
            throw new BackendException(400, "關鍵字最多 " + maxCount + " 個。");
        }
        return keywords;
    }

    private String validateNoiseReduction(Object value) throws JSONException, BackendException {
        String type = stringOr(value, defaults.getString("noiseReduction"));
        if (!contains("noiseReductionTypes", type)) {
            throw new BackendException(400, "不支援的降噪設定。");
        }
        return type;
    }

    private boolean contains(String listName, String value) throws JSONException {
        JSONArray list = config.getJSONArray(listName);
        for (int index = 0; index < list.length(); index += 1) {
            if (value.equals(list.getString(index))) return true;
        }
        return false;
    }

    private static String stringOr(Object value, String fallback) {
        return value instanceof String && !((String) value).isEmpty() ? (String) value : fallback;
    }

    private static JSONObject error(String message) {
        try {
            return new JSONObject().put("error", message);
        } catch (JSONException exception) {
            return new JSONObject();
        }
    }

    // ---- OpenAI calls ----

    private Response createClientSecret(String endpoint, JSONObject payload) throws BackendException {
        String key = apiKey;
        if (key == null) throw new BackendException(401, "尚未設定 API key。");
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + key);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("OpenAI-Safety-Identifier", "local-android-user");
            byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = input == null ? "" : new String(readAll(input), StandardCharsets.UTF_8);
            Object data;
            try {
                data = new JSONObject(text);
            } catch (JSONException exception) {
                data = error("OpenAI 回應格式錯誤。");
            }
            return new Response(status, data);
        } catch (SocketTimeoutException exception) {
            throw new BackendException(504, "OpenAI 回應逾時，請稍後再試。");
        } catch (IOException exception) {
            throw new BackendException(502, "無法連線到 OpenAI，請檢查網路。");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // Same checks as verifyApiKey() in server/index.mjs.
    private JSONArray verifyKey(String key) throws BackendException, JSONException {
        String[] models = {
            config.getJSONObject("models").getString("translation"),
            config.getJSONObject("models").getString("transcription"),
        };
        ExecutorService executor = Executors.newFixedThreadPool(models.length);
        int[] statuses = new int[models.length];
        try {
            List<Future<Integer>> futures = new ArrayList<>();
            for (String model : models) futures.add(executor.submit(() -> modelStatus(key, model)));
            for (int index = 0; index < models.length; index += 1) {
                try {
                    statuses[index] = futures.get(index).get();
                } catch (Exception exception) {
                    statuses[index] = 0;
                }
            }
        } finally {
            executor.shutdownNow();
        }
        for (int status : statuses) {
            if (status == 401) throw new BackendException(400, "OpenAI 拒絕這把金鑰（無效或已撤銷）。");
        }
        Set<String> warnings = new LinkedHashSet<>();
        for (int index = 0; index < models.length; index += 1) {
            int status = statuses[index];
            if (status == 0) warnings.add("暫時無法連線到 OpenAI 驗證金鑰，已先儲存。");
            else if (status == 403 || status == 404) warnings.add("這把金鑰目前無法使用 " + models[index] + "。");
            else if (status >= 400) warnings.add("驗證 " + models[index] + " 時 OpenAI 回應 " + status + "。");
        }
        return new JSONArray(warnings);
    }

    private static int modelStatus(String key, String model) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(OPENAI + "/models/" + model).openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setRequestProperty("Authorization", "Bearer " + key);
            return connection.getResponseCode();
        } catch (IOException exception) {
            return 0;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static String readAsset(Context context, String name) throws IOException {
        try (InputStream input = context.getAssets().open(name)) {
            return new String(readAll(input), StandardCharsets.UTF_8);
        }
    }

    static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        return output.toByteArray();
    }
}
