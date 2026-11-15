// Embeds the icon (resource id 1: exe icon and window icon) and the version info into Unfold.exe.
fn main() {
    let mut res = winresource::WindowsResource::new();
    res.set_icon_with_id("assets/icon.ico", "1");
    res.set("FileDescription", "Unfold – Jellyfin Player");
    res.set("ProductName", "Unfold – Jellyfin Player");
    res.compile().expect("resource compiler (Windows SDK) missing");
}
