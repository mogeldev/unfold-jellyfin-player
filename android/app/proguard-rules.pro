# Methods called from web/webapi.js through window.Android
-keepclassmembers class io.github.mogeldev.unfold.MainActivity {
    @android.webkit.JavascriptInterface <methods>;
}
