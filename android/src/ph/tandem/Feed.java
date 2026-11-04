package ph.tandem;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;
import java.util.Calendar;
import java.util.HashSet;
import java.util.Set;

/**
 * Background alerts: every ~15 minutes the phone asks the Tandem database
 * (notif_feed, with this device's private token) for new mentions, assignments,
 * reviews, comments, blockers and due dates, and shows them as notifications.
 * Works while the app is closed. No Google services needed.
 */
public class Feed {
    static final String CHANNEL = "activity";
    static final String ACTION = "ph.tandem.FEED";

    static SharedPreferences prefs(Context c) { return Morning.prefs(c); }

    static String token(Context c) {
        SharedPreferences sp = prefs(c);
        String t = sp.getString("ntoken", null);
        if (t == null || t.length() < 32) {
            byte[] b = new byte[24];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            t = sb.toString();
            sp.edit().putString("ntoken", t).apply();
        }
        return t;
    }

    static void register(Context c, String url, String key) {
        SharedPreferences.Editor e = prefs(c).edit();
        if (url == null || url.trim().isEmpty()) {
            e.remove("nurl").remove("nkey").remove("nsince").apply();
        } else {
            e.putString("nurl", url.trim().replaceAll("/+$", "")).putString("nkey", key == null ? "" : key.trim()).apply();
        }
        schedule(c);
        if (url != null && !url.trim().isEmpty()) poll(c, null);
    }

    static boolean registered(Context c) {
        SharedPreferences sp = prefs(c);
        return !sp.getString("nurl", "").isEmpty() && !sp.getString("nkey", "").isEmpty();
    }

    static PendingIntent alarmIntent(Context c) {
        Intent i = new Intent(c, MorningReceiver.class);
        i.setAction(ACTION);
        return PendingIntent.getBroadcast(c, 3, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void schedule(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = alarmIntent(c);
        am.cancel(pi);
        if (!registered(c)) return;
        am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP,
            SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_FIFTEEN_MINUTES,
            AlarmManager.INTERVAL_FIFTEEN_MINUTES, pi);
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Task activity", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Mentions, assignments, reviews, comments, blockers and due dates");
            nm.createNotificationChannel(ch);
        }
    }

    /** Runs the network call off the main thread; done (may be null) runs afterwards. */
    static void poll(final Context ctx, final Runnable done) {
        final Context c = ctx.getApplicationContext();
        new Thread(new Runnable() { public void run() {
            try { fetch(c); } catch (Exception e) { /* offline or not set up: try again next time */ }
            if (done != null) done.run();
        }}).start();
    }

    static void fetch(Context c) throws Exception {
        SharedPreferences sp = prefs(c);
        String base = sp.getString("nurl", ""), key = sp.getString("nkey", "");
        if (base.isEmpty() || key.isEmpty()) return;
        JSONObject body = new JSONObject();
        body.put("p_token", token(c));
        String since = sp.getString("nsince", null);
        body.put("p_since", since == null ? JSONObject.NULL : since);
        HttpURLConnection h = (HttpURLConnection) new URL(base + "/rest/v1/rpc/notif_feed").openConnection();
        h.setConnectTimeout(15000); h.setReadTimeout(15000);
        h.setRequestMethod("POST"); h.setDoOutput(true);
        h.setRequestProperty("apikey", key);
        h.setRequestProperty("Content-Type", "application/json");
        OutputStream os = h.getOutputStream(); os.write(body.toString().getBytes("UTF-8")); os.close();
        if (h.getResponseCode() != 200) { h.disconnect(); return; }
        InputStream in = h.getInputStream(); ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[4096]; int n; while ((n = in.read(buf)) > 0) bo.write(buf, 0, n); in.close(); h.disconnect();
        JSONObject res = new JSONObject(bo.toString("UTF-8"));
        if (!res.optBoolean("ok", false)) return;

        JSONObject mute = new JSONObject();
        try { mute = new JSONObject(sp.getString("nmute", "{}")); } catch (Exception e) { }
        Set<String> seen = new HashSet<String>(sp.getStringSet("nseen", new HashSet<String>()));
        boolean first = since == null;   // first sync: don't flood with old items
        JSONArray items = res.optJSONArray("items");
        if (items != null) for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.getJSONObject(i);
            String id = it.optString("id");
            if (seen.contains(id)) continue;
            seen.add(id);
            if (first || mute.optBoolean(it.optString("kind"), false)) continue;
            show(c, id, icon(it.optString("kind")) + " " + it.optString("title"), it.optString("body"), it.optString("project"), it.optString("task"));
        }
        // Due reminders: once per task per day, during waking hours.
        int hr = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        JSONArray due = res.optJSONArray("due");
        if (due != null && hr >= 8 && hr < 21 && !mute.optBoolean("due", false)) for (int i = 0; i < due.length(); i++) {
            JSONObject it = due.getJSONObject(i);
            String id = it.optString("id");
            if (seen.contains(id)) continue;
            seen.add(id);
            String st = it.optString("state");
            String head = "overdue".equals(st) ? "⚠️ Overdue" : "today".equals(st) ? "📅 Due today" : "📅 Due tomorrow";
            show(c, id, head + ": " + it.optString("title"), "Tap to open the task", it.optString("project"), it.optString("task"));
        }
        if (seen.size() > 300) { Set<String> keep = new HashSet<String>(); for (String s : seen) { if (keep.size() < 150) keep.add(s); } seen = keep; }
        sp.edit().putStringSet("nseen", seen).putString("nsince", res.optString("now", since)).apply();
    }

    static String icon(String kind) {
        if ("mention".equals(kind)) return "💬";
        if ("assigned".equals(kind)) return "👤";
        if ("review".equals(kind)) return "👀";
        if ("comment".equals(kind)) return "💬";
        if ("blocker".equals(kind)) return "⛔";
        if ("done".equals(kind)) return "✅";
        return "🔔";
    }

    static void show(Context c, String id, String title, String text, String project, String task) {
        ensureChannel(c);
        Intent open = new Intent(c, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("open_project", project == null || "null".equals(project) ? "" : project);
        open.putExtra("open_task", task == null || "null".equals(task) ? "" : task);
        int nid = 1000 + (id.hashCode() & 0x7ffffff);
        PendingIntent pi = PendingIntent.getActivity(c, nid, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_stat)
         .setContentTitle(title)
         .setContentText(text)
         .setStyle(new Notification.BigTextStyle().bigText(text))
         .setContentIntent(pi)
         .setAutoCancel(true)
         .setColor(0xFF2A6F97);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(nid, b.build());
        } catch (SecurityException e) { /* notifications not permitted */ }
    }
}
