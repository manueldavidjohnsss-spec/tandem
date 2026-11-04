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
import org.json.JSONArray;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** Daily "morning brief" notification, built from the last data the app synced. */
public class Morning {
    static final String PREFS = "tandem";
    static final String CHANNEL = "morning";

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static PendingIntent alarmIntent(Context c) {
        Intent i = new Intent(c, MorningReceiver.class);
        i.setAction("ph.tandem.MORNING");
        return PendingIntent.getBroadcast(c, 1, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void schedule(Context c) {
        SharedPreferences sp = prefs(c);
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = alarmIntent(c);
        am.cancel(pi);
        if (!sp.getBoolean("on", false)) return;
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, sp.getInt("h", 8));
        cal.set(Calendar.MINUTE, sp.getInt("m", 0));
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        if (cal.getTimeInMillis() <= System.currentTimeMillis() + 1000) cal.add(Calendar.DAY_OF_YEAR, 1);
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Morning brief", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("Your plan for the day, every morning");
            nm.createNotificationChannel(ch);
        }
    }

    static void show(Context c) {
        ensureChannel(c);
        String[] t = compose(c);
        Intent open = new Intent(c, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 2, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_stat)
         .setContentTitle(t[0])
         .setContentText(t[1])
         .setStyle(new Notification.BigTextStyle().bigText(t[2]))
         .setContentIntent(pi)
         .setAutoCancel(true)
         .setColor(0xFF2A6F97);
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(7, b.build());
        } catch (SecurityException e) { /* notifications not permitted */ }
    }

    static String join(List<String> xs, int max) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < xs.size() && i < max; i++) { if (i > 0) sb.append(", "); sb.append(xs.get(i)); }
        if (xs.size() > max) sb.append(" +").append(xs.size() - max).append(" more");
        return sb.toString();
    }

    /** Returns {title, short text, long text}. */
    static String[] compose(Context c) {
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        String name = "", theme = "classic", project = "your project", synced = "";
        List<String> dueToday = new ArrayList<>(), overdue = new ArrayList<>(), doing = new ArrayList<>(), blockers = new ArrayList<>();
        int review = 0;
        try {
            JSONObject o = new JSONObject(prefs(c).getString("brief", "{}"));
            name = o.optString("name", "");
            theme = o.optString("theme", "classic");
            project = o.optString("project", project);
            synced = o.optString("synced", "");
            review = o.optInt("review", 0);
            JSONArray ts = o.optJSONArray("tasks");
            if (ts != null) for (int i = 0; i < ts.length(); i++) {
                JSONObject t = ts.getJSONObject(i);
                String due = t.optString("due", ""), st = t.optString("status", ""), title = t.optString("t", "");
                if ("Done".equals(st)) continue;
                if (due.length() == 10 && due.compareTo(today) < 0) overdue.add(title);
                else if (today.equals(due)) dueToday.add(title);
                if ("In Progress".equals(st)) doing.add(title);
            }
            JSONArray bl = o.optJSONArray("blockers");
            if (bl != null) for (int i = 0; i < bl.length(); i++) blockers.add(bl.getString(i));
        } catch (Exception e) { /* no data yet */ }

        String first = name.isEmpty() ? "" : ", " + name.split(" ")[0];
        String title;
        if ("squid".equals(theme)) title = "🦑 Good morning" + first + "! Time to make waves";
        else if ("cat".equals(theme)) title = "🐱 Rise and shine" + first + "!";
        else title = "☀️ Good morning" + first;

        List<String> parts = new ArrayList<>();
        if (!dueToday.isEmpty()) parts.add(dueToday.size() + " due today");
        if (!overdue.isEmpty()) parts.add(overdue.size() + " overdue");
        if (!doing.isEmpty()) parts.add(doing.size() + " in progress");
        if (review > 0) parts.add(review + " to review");
        String shortText = parts.isEmpty() ? "No deadlines today. Post your standup in Tandem." : join(parts, 4) + " · post your standup";

        StringBuilder lng = new StringBuilder();
        lng.append(project).append("\n");
        if (!dueToday.isEmpty()) lng.append("📅 Due today: ").append(join(dueToday, 3)).append("\n");
        if (!overdue.isEmpty()) lng.append("⚠️ Overdue: ").append(join(overdue, 3)).append("\n");
        if (!doing.isEmpty()) lng.append("▶ In progress: ").append(join(doing, 3)).append("\n");
        if (review > 0) lng.append("👀 ").append(review).append(" task(s) waiting for your review\n");
        if (!blockers.isEmpty()) lng.append("⛔ Teammate blocker: ").append(join(blockers, 2)).append("\n");
        if (parts.isEmpty() && blockers.isEmpty()) lng.append("No deadlines today. Pick your top task.\n");
        lng.append("Post your standup: done · today · blockers.");
        if (synced.length() == 10) {
            try {
                long days = (new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(today).getTime()
                        - new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(synced).getTime()) / 86400000L;
                if (days >= 2) lng.append("\n(Last synced ").append(days).append(" days ago. Open Tandem to refresh.)");
            } catch (Exception e) { }
        }
        return new String[]{title, shortText, lng.toString()};
    }
}
