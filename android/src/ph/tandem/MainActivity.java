package ph.tandem;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private WebView web;
    private String appUrl = "";
    private String appHost = "";
    private String pendingCallback = null;
    private boolean pageReady = false;
    private boolean usingFallback = false;
    static final String LOCAL = "file:///android_asset/index.html";

    public class Bridge {
        @JavascriptInterface
        public boolean copy(String text) {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("Tandem", text));
                return true;
            } catch (Exception e) { return false; }
        }

        @JavascriptInterface
        public void openExternal(String url) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            } catch (Exception e) { }
        }

        @JavascriptInterface
        public void setAppUrl(final String url) {
            Morning.prefs(MainActivity.this).edit().putString("app_url", url == null ? "" : url.trim()).apply();
            runOnUiThread(new Runnable() { public void run() { configureUrl(); usingFallback = false; pageReady = false;
                if (!appUrl.isEmpty()) web.loadUrl(appUrl); else { usingFallback = true; web.loadUrl(LOCAL); } } });
        }

        @JavascriptInterface
        public boolean savePng(String base64, String name) {
            try {
                byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                if (name == null || name.isEmpty()) name = "tandem-board.png";
                if (Build.VERSION.SDK_INT >= 29) {
                    android.content.ContentValues v = new android.content.ContentValues();
                    v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "image/png");
                    v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/Tandem");
                    Uri uri = getContentResolver().insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return false;
                    java.io.OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(bytes); os.close();
                    return true;
                } else {
                    java.io.File dir = new java.io.File(getExternalFilesDir(android.os.Environment.DIRECTORY_PICTURES), "Tandem");
                    dir.mkdirs();
                    java.io.File f = new java.io.File(dir, name);
                    java.io.FileOutputStream fo = new java.io.FileOutputStream(f);
                    fo.write(bytes); fo.close();
                    return true;
                }
            } catch (Exception e) { return false; }
        }

        @JavascriptInterface
        public String appInfo() {
            return "{\"remote\":" + (!usingFallback && !appUrl.isEmpty()) + ",\"version\":\"" + BuildConfigLite.VERSION + "\",\"code\":" + BuildConfigLite.CODE + ",\"canInstall\":true}";
        }

        /** Downloads a newer APK and opens Android's installer for it. */
        @JavascriptInterface
        public boolean installUpdate(String url) {
            try {
                final android.app.DownloadManager dm = (android.app.DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                android.app.DownloadManager.Request r = new android.app.DownloadManager.Request(Uri.parse(url));
                r.setTitle("Tandem update");
                r.setDescription("Downloading the latest Tandem app");
                r.setMimeType("application/vnd.android.package-archive");
                r.setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                r.setDestinationInExternalFilesDir(MainActivity.this, android.os.Environment.DIRECTORY_DOWNLOADS, "Tandem-update-" + System.currentTimeMillis() + ".apk");
                final long id = dm.enqueue(r);
                android.content.BroadcastReceiver done = new android.content.BroadcastReceiver() {
                    @Override public void onReceive(Context c, Intent i) {
                        if (i.getLongExtra(android.app.DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return;
                        try { unregisterReceiver(this); } catch (Exception e) { }
                        Uri apk = dm.getUriForDownloadedFile(id);
                        if (apk == null) { js("window.TandemUpdateFailed&&TandemUpdateFailed()"); return; }
                        Intent install = new Intent(Intent.ACTION_VIEW);
                        install.setDataAndType(apk, "application/vnd.android.package-archive");
                        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                        try { startActivity(install); } catch (Exception e) { js("window.TandemUpdateFailed&&TandemUpdateFailed()"); }
                    }
                };
                android.content.IntentFilter f = new android.content.IntentFilter(android.app.DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                if (Build.VERSION.SDK_INT >= 33) registerReceiver(done, f, 2 /* RECEIVER_EXPORTED */);
                else registerReceiver(done, f);
                return true;
            } catch (Exception e) { return false; }
        }

        @JavascriptInterface
        public String morningGet() {
            android.content.SharedPreferences sp = Morning.prefs(MainActivity.this);
            boolean perm = Build.VERSION.SDK_INT < 33 || checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
            return "{\"on\":" + sp.getBoolean("on", false) + ",\"h\":" + sp.getInt("h", 8) + ",\"m\":" + sp.getInt("m", 0) + ",\"perm\":" + perm + "}";
        }

        @JavascriptInterface
        public void morningSet(boolean on, int h, int m) {
            Morning.prefs(MainActivity.this).edit().putBoolean("on", on).putInt("h", h).putInt("m", m).apply();
            if (on) askPermission();
            Morning.schedule(MainActivity.this);
        }

        @JavascriptInterface
        public void saveBrief(String json) {
            Morning.prefs(MainActivity.this).edit().putString("brief", json).apply();
        }

        @JavascriptInterface
        public String notifyToken() { return Feed.token(MainActivity.this); }

        @JavascriptInterface
        public void notifyRegister(String url, String key) {
            if (url != null && !url.isEmpty()) askPermission();
            Feed.register(MainActivity.this, url, key);
        }

        @JavascriptInterface
        public void notifyConfig(String json) {
            try { org.json.JSONObject o = new org.json.JSONObject(json); Morning.prefs(MainActivity.this).edit().putString("nmute", o.optJSONObject("mute") == null ? "{}" : o.optJSONObject("mute").toString()).apply(); } catch (Exception e) { }
        }

        @JavascriptInterface
        public String notifyStatus() {
            boolean perm = Build.VERSION.SDK_INT < 33 || checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
            return "{\"perm\":" + perm + ",\"registered\":" + Feed.registered(MainActivity.this) + "}";
        }

        @JavascriptInterface
        public void notifyPerm() { askPermission(); }

        @JavascriptInterface
        public void notifyTest() {
            askPermission();
            Feed.show(MainActivity.this, "test-" + System.currentTimeMillis(), "🔔 Tandem alerts are working", "Mentions, assignments, reviews and due dates will appear like this, even when the app is closed.", "", "");
        }

        @JavascriptInterface
        public void morningTest() {
            askPermission();
            Morning.show(MainActivity.this);
        }
    }

    private void askPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            runOnUiThread(new Runnable() { public void run() { requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 5); } });
        }
    }

    /** Site address: chosen in the app (saved) > built into the APK > none (bundled copy). */
    private void configureUrl() {
        String saved = Morning.prefs(this).getString("app_url", null);
        appUrl = (saved != null && !saved.isEmpty()) ? saved : getString(R.string.app_url).trim();
        appHost = "";
        if (!appUrl.isEmpty()) { try { appHost = Uri.parse(appUrl).getHost(); if (appHost == null) appUrl = ""; } catch (Exception e) { appUrl = ""; } }
    }

    private boolean online() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkInfo ni = cm.getActiveNetworkInfo();
            return ni != null && ni.isConnected();
        } catch (Exception e) { return true; }
    }

    private void loadFallback() {
        if (usingFallback) return;
        usingFallback = true;
        web.loadUrl(LOCAL);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureUrl();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String sc = u.getScheme();
                if ("file".equals(sc)) return false;
                if (!appHost.isEmpty() && appHost.equals(u.getHost())) return false;
                if ("ph.tandem".equals(sc)) { handleCallback(u.toString()); return true; }
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame() && !usingFallback) loadFallback();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                if (pendingCallback != null) { String c = pendingCallback; pendingCallback = null; deliver(c); }
                deliverOpen();
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        setContentView(web);
        Morning.ensureChannel(this);
        Morning.schedule(this);
        Feed.schedule(this);
        takeOpen(getIntent());

        if (getIntent() != null && getIntent().getData() != null) pendingCallback = getIntent().getData().toString();
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else if (!appUrl.isEmpty() && online()) web.loadUrl(appUrl);
        else { usingFallback = true; web.loadUrl(LOCAL); }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && intent.getData() != null) handleCallback(intent.getData().toString());
        if (takeOpen(intent) && pageReady) deliverOpen();
    }

    private String openP = null, openT = null;

    /** A notification was tapped: remember which task to open. */
    private boolean takeOpen(Intent i) {
        if (i == null || !i.hasExtra("open_project")) return false;
        openP = i.getStringExtra("open_project"); openT = i.getStringExtra("open_task");
        i.removeExtra("open_project"); i.removeExtra("open_task");
        return true;
    }

    private void deliverOpen() {
        if (openP == null) return;
        final String p = openP.replaceAll("[^0-9a-fA-F-]", ""), t = (openT == null ? "" : openT).replaceAll("[^0-9a-fA-F-]", "");
        openP = null; openT = null;
        web.post(new Runnable() { public void run() {
            web.evaluateJavascript("(function(){var n=0;(function go(){if(window.TandemOpen){TandemOpen('" + p + "','" + t + "')}else if(n++<60){setTimeout(go,250)}})()})()", null);
        }});
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (pageReady) web.evaluateJavascript("window.loadNotifsNow&&loadNotifsNow()", null);
    }

    private void handleCallback(String url) {
        if (!url.startsWith("ph.tandem://auth-callback")) return;
        if (pageReady) deliver(url); else pendingCallback = url;
    }

    private void js(final String code) {
        web.post(new Runnable() { public void run() { web.evaluateJavascript(code, null); } });
    }

    private void deliver(final String url) {
        final String safe = url.replace("\\", "\\\\").replace("'", "\\'");
        web.post(new Runnable() { public void run() {
            web.evaluateJavascript("(function(){var t=0;(function go(){if(window.TandemAuthCallback){TandemAuthCallback('" + safe + "')}else if(t++<40){setTimeout(go,150)}})()})()", null);
        }});
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.TandemBack&&window.TandemBack())?'1':'0'", new ValueCallback<String>() {
            @Override public void onReceiveValue(String v) {
                if (v == null || !v.contains("1")) finish();
            }
        });
    }
}
