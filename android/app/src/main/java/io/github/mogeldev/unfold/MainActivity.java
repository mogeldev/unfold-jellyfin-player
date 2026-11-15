package io.github.mogeldev.unfold;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
import android.net.Uri;
import android.os.Bundle;
import android.os.IBinder;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import live.mehiz.mpvkt.ui.player.MediaPlaybackService;
import live.mehiz.mpvkt.ui.player.PlayerActivity;

/**
 * Shell around the frontend in web/ (bundled as assets). The backend is web/webapi.js; this class only starts the
 * player: PlayerActivity of mpvkt-rolling (submodule android/mpvkt), built into this APK, and passes the result back.
 */
public class MainActivity extends Activity {
    private static final int PLAY = 1;
    private WebView web;
    private MediaPlaybackService player; // bound while a video plays, for the position in the progress reports

    private final ServiceConnection conn = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder b) {
            player = ((MediaPlaybackService.MediaPlaybackBinder) b).getService();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            player = null;
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true); // localStorage: accounts, theme, text size
        web.addJavascriptInterface(this, "Android"); // only the bundled page is ever loaded, no remote scripts
        web.loadUrl("file:///android_asset/index.html");
        setContentView(web);
    }

    /**
     * Called from webapi.js with {url, title, id, position (ms), vid, aid, sid (mpv values), subs: [url]}.
     * Extras as in the mpv-android intent API, plus media_id and vid/aid/sid, which the fork reads.
     */
    @JavascriptInterface
    public void play(String json) throws JSONException {
        JSONObject o = new JSONObject(json);
        Intent i = new Intent(this, PlayerActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse(o.getString("url")))
                .putExtra("title", o.getString("title"))
                .putExtra("media_id", o.getString("id")) // saved player state per Jellyfin item, not per URL ("stream")
                .putExtra("position", o.getInt("position"));
        for (String k : new String[]{"vid", "aid", "sid"})
            if (o.has(k)) i.putExtra(k, o.getString(k));
        JSONArray subs = o.getJSONArray("subs");
        if (subs.length() > 0) {
            Uri[] uris = new Uri[subs.length()];
            for (int n = 0; n < uris.length; n++) uris[n] = Uri.parse(subs.getString(n));
            i.putExtra("subs", uris);
        }
        runOnUiThread(() -> {
            startActivityForResult(i, PLAY);
            // PlayerActivity starts the service; binding here only reads it and does not keep it alive
            bindService(new Intent(this, MediaPlaybackService.class), conn, 0);
        });
    }

    /** Called from webapi.js for the progress reports: position in ms, -1 if unknown. */
    @JavascriptInterface
    public int position() {
        MediaPlaybackService p = player;
        return p == null ? -1 : (int) p.currentPositionMs();
    }

    /** mpvkt's own screen: decoder, subtitle, gesture settings etc. Called from the settings dialog. */
    @JavascriptInterface
    public void playerSettings() {
        runOnUiThread(() -> startActivity(new Intent(this, live.mehiz.mpvkt.MainActivity.class)));
    }

    /** Player closed: position in ms (the fork always sends it when playback started), -1 = did not start. */
    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != PLAY) return;
        try {
            unbindService(conn);
        } catch (IllegalArgumentException ignored) { // was not bound
        }
        player = null;
        int pos = result == RESULT_OK && data != null ? data.getIntExtra("position", -1) : -1;
        web.evaluateJavascript("window.onPlayerResult && window.onPlayerResult(" + pos + ")", null);
    }

    /** Back: one column to the left (app.js goBack); at the first column the app closes. */
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("!!(window.goBack && window.goBack())", v -> {
            if (!"true".equals(v)) finish();
        });
    }
}
