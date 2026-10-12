package local.keynotelivetranslator;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.Key;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Optional persistence of the API key, used only when the user ticks "記住金鑰". The key is encrypted
 * with an AES-GCM key held in the Android Keystore; only the ciphertext is stored in app-private
 * preferences (excluded from backups by android:allowBackup="false").
 */
final class SecureKeyStore {
    private static final String KEY_ALIAS = "klt-openai-api-key";
    private static final String PREFERENCES = "klt-secure";
    private static final String VALUE = "apiKey";
    private static final String IV = "apiKeyIv";

    private final SharedPreferences preferences;

    SecureKeyStore(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    synchronized boolean save(String value) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            preferences.edit()
                .putString(VALUE, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString(IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .apply();
            return true;
        } catch (Exception exception) {
            delete();
            return false;
        }
    }

    synchronized String load() {
        String value = preferences.getString(VALUE, null);
        String iv = preferences.getString(IV, null);
        if (value == null || iv == null) return null;
        try {
            Key key = keyStore().getKey(KEY_ALIAS, null);
            if (key == null) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(value, Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception exception) {
            delete();
            return null;
        }
    }

    synchronized void delete() {
        preferences.edit().remove(VALUE).remove(IV).apply();
        try {
            keyStore().deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
            // Nothing stored.
        }
    }

    private static KeyStore keyStore() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    private static SecretKey getOrCreateKey() throws Exception {
        Key existing = keyStore().getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }
}
