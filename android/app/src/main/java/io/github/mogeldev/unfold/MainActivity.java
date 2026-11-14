package io.github.mogeldev.unfold;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.os.Bundle;
import android.system.Os;
import android.util.Base64;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import java.io.File;
import java.io.FileWriter;
import java.io.Writer;
import java.security.KeyStore;
import java.util.Collections;

import dev.jdtech.mpv.MPVLib;

/**
 * Shell around the frontend in web/ (bundled as assets). The backend is web/webapi.js; this class only plays:
 * libmpv renders into a SurfaceView on top of the WebView, like embed.py on Windows. Controls are mpv's own OSC.
 */
public class MainActivity extends Activity implements MPVLib.EventObserver, SurfaceHolder.Callback {
    private WebView web;
    private MPVLib mpv;        // set while a video plays (UI thread)
    private SurfaceView video;
    private String url;        // loaded once the surface exists
    private volatile int pos;  // last playback position in ms

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

    /** Called from webapi.js. opts: mpv options, one "name=value" per line. Ends with window.onPlayerResult(ms). */
    @JavascriptInterface
    public void play(String url, int startMs, String opts) {
        runOnUiThread(() -> {
            if (mpv != null) return; // one player at a time
            MPVLib m = MPVLib.Companion.create(this);
            try {
                // Without fontconfig mpv takes ~~/subfont.ttf for the OSC and subtitles.
                // shortcut: Roboto has no CJK glyphs; link a Noto CJK font instead if such subtitles show boxes.
                File font = new File(getFilesDir(), "subfont.ttf");
                if (!font.exists()) Os.symlink("/system/fonts/Roboto-Regular.ttf", font.getPath());
                m.setOptionString("tls-ca-file", caFile());
                m.setOptionString("tls-verify", "yes"); // mpv's default is no; the stream URL carries the token
            } catch (Exception e) {
                m.destroy();
                fail(e);
                return;
            }
            m.setOptionString("config-dir", getFilesDir().getPath());
            m.setOptionString("vo", "gpu");
            m.setOptionString("gpu-context", "android");
            m.setOptionString("hwdec", "mediacodec-copy"); // falls back to software decoding
            m.setOptionString("ao", "audiotrack,opensles");
            m.setOptionString("osc", "yes");
            m.setOptionString("script-opts", "osc-vidscale=no,osc-scalewindowed=2,osc-scalefullscreen=2,osc-hidetimeout=3000"); // finger-sized; a tap shows it for 3 s
            m.setOptionString("ytdl", "no");
            for (String o : opts.split("\n")) { // after the defaults: the user's mpv options win
                int eq = o.indexOf('=');
                if (eq > 0) m.setOptionString(o.substring(0, eq), o.substring(eq + 1));
            }
            m.init();
            m.addObserver(this);
            m.observeProperty("time-pos", MPVLib.MpvFormat.MPV_FORMAT_INT64); // whole seconds are enough for resume
            mpv = m;
            pos = startMs;
            this.url = url;
            video = new SurfaceView(this);
            video.getHolder().addCallback(this);
            video.setOnTouchListener(this::touch);
            addContentView(video, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        });
    }

    /** Called from webapi.js for the progress reports. */
    @JavascriptInterface
    public int position() {
        return pos;
    }

    /** All CA certificates Android trusts (system and user-installed) as one PEM file for mpv. */
    private String caFile() throws Exception {
        File f = new File(getCacheDir(), "ca.pem");
        KeyStore ks = KeyStore.getInstance("AndroidCAStore");
        ks.load(null);
        try (Writer w = new FileWriter(f)) {
            for (String alias : Collections.list(ks.aliases()))
                w.write("-----BEGIN CERTIFICATE-----\n"
                        + Base64.encodeToString(ks.getCertificate(alias).getEncoded(), Base64.DEFAULT)
                        + "-----END CERTIFICATE-----\n");
        }
        return f.getPath();
    }

    private void fail(Exception e) {
        web.evaluateJavascript("window.onPlayerResult && window.onPlayerResult(" + pos + ")", null);
        android.util.Log.e("Unfold", "player", e);
    }

    /** Touch drives mpv's OSC as a mouse: finger down = left button down. */
    private boolean touch(View v, MotionEvent e) {
        MPVLib m = mpv;
        if (m == null) return false;
        int a = e.getActionMasked();
        if (a == MotionEvent.ACTION_DOWN || a == MotionEvent.ACTION_MOVE)
            m.command(new String[]{"mouse", String.valueOf((int) e.getX()), String.valueOf((int) e.getY())});
        if (a == MotionEvent.ACTION_DOWN) m.command(new String[]{"keydown", "MBTN_LEFT"});
        if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) {
            m.command(new String[]{"keyup", "MBTN_LEFT"});
            // A finger leaves no pointer behind: without this the OSC would stay open where it was last touched
            v.removeCallbacks(leave);
            v.postDelayed(leave, 3000);
        }
        return true;
    }

    private final Runnable leave = () -> {
        if (mpv != null) mpv.command(new String[]{"keypress", "MOUSE_LEAVE"});
    };

    // ---- Surface: mpv only has a video output while the surface exists (it goes away when the app is in the background) ----
    @Override
    public void surfaceCreated(SurfaceHolder h) {
        mpv.attachSurface(h.getSurface());
        mpv.setOptionString("force-window", "yes");
        mpv.setPropertyString("vo", "gpu");
        if (url != null) mpv.command(new String[]{"loadfile", url});
        url = null;
    }

    @Override
    public void surfaceChanged(SurfaceHolder h, int format, int w, int ht) {
        mpv.setPropertyString("android-surface-size", w + "x" + ht);
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder h) {
        mpv.setPropertyString("vo", "null");
        mpv.setOptionString("force-window", "no");
        mpv.detachSurface();
    }

    // ---- mpv events (mpv's thread) ----
    @Override
    public void eventProperty(String name, long value) {
        if (name.equals("time-pos")) pos = (int) (value * 1000);
    }

    @Override
    public void event(int id) { // end of file, or the file could not be opened
        if (id == MPVLib.MpvEvent.MPV_EVENT_END_FILE) runOnUiThread(this::stop);
    }

    @Override public void eventProperty(String name) { }
    @Override public void eventProperty(String name, double value) { }
    @Override public void eventProperty(String name, boolean value) { }
    @Override public void eventProperty(String name, String value) { }

    /** Back to the library; webapi.js sends the Stopped report with the position. */
    private void stop() {
        MPVLib m = mpv;
        if (m == null) return;
        mpv = null;
        m.removeObserver(this);
        video.removeCallbacks(leave);
        video.getHolder().removeCallback(this);
        m.setPropertyString("vo", "null");
        m.detachSurface();
        m.destroy();
        ((ViewGroup) video.getParent()).removeView(video);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setSystemUiVisibility(0);
        web.evaluateJavascript("window.onPlayerResult && window.onPlayerResult(" + pos + ")", null);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (mpv != null) mpv.setPropertyBoolean("pause", true);
    }

    @Override
    protected void onDestroy() {
        stop();
        super.onDestroy();
    }

    /** Back: leave the video, else one column to the left (app.js goBack); at the first column the app closes. */
    @Override
    public void onBackPressed() {
        if (mpv != null) {
            stop();
            return;
        }
        web.evaluateJavascript("!!(window.goBack && window.goBack())", v -> {
            if (!"true".equals(v)) finish();
        });
    }
}
