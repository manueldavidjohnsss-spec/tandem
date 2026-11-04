package ph.tandem;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class MorningReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String a = i.getAction();
        if ("ph.tandem.MORNING".equals(a)) Morning.show(c);
        Morning.schedule(c); // boot, app update, time change, or next day
    }
}
