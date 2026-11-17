package io.github.jason2538.crossfade;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.List;

/**
 * 크로스페이드(Luma·Aria 포함) 웹사이트를 앱처럼 보여 주는 화면 하나짜리 앱입니다.
 *
 * Spotify 로그인은 앱 안 화면에서 막히는 경우가 있어서(특히 Google 로그인) 휴대폰 기본 브라우저에서 합니다.
 * 이때 state 앞에 "app." 을 붙여 보내고, 로그인을 마친 브라우저가 크로스페이드 주소에서 그 표시를 보고
 * crossfade://callback 으로 앱을 다시 엽니다. 앱은 "app." 을 떼고 결과를 웹 화면에 넘겨 로그인을 마칩니다.
 */
public class MainActivity extends Activity {

    private static final String HOME = "https://jason2538.github.io/crossfade/";
    private static final String APP_MARK = "app.";

    private WebView web;

    private static boolean isInternal(Uri uri) {
        return "https".equals(uri.getScheme()) && "jason2538.github.io".equals(uri.getHost())
                && uri.getPath() != null && uri.getPath().startsWith("/crossfade");
    }

    private static boolean isSpotifyLogin(Uri uri) {
        return "accounts.spotify.com".equals(uri.getHost()) && uri.getPath() != null && uri.getPath().endsWith("/authorize");
    }

    /** state 값만 바꾼 같은 주소를 만듭니다. */
    private static Uri withState(Uri uri, String state) {
        Uri.Builder builder = uri.buildUpon().clearQuery();
        for (String name : uri.getQueryParameterNames()) {
            String value = "state".equals(name) ? state : uri.getQueryParameter(name);
            builder.appendQueryParameter(name, value);
        }
        return builder.build();
    }

    private void openOutside(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // 열 수 있는 앱이 없으면 그대로 둡니다.
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(0xFFF2F2F7);
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // 웹 화면이 앱 안인지 알 수 있게 표시를 붙입니다.
        settings.setUserAgentString(settings.getUserAgentString().replace("; wv", "") + " CrossfadeApp/1.0");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isInternal(uri)) return false;
                if (isSpotifyLogin(uri)) {
                    String state = uri.getQueryParameter("state");
                    if (state != null && !state.startsWith(APP_MARK)) uri = withState(uri, APP_MARK + state);
                }
                // 나머지 주소(Spotify 로그인, Spotify에서 열기 등)는 기본 브라우저나 해당 앱으로 엽니다.
                openOutside(uri);
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 음악 재생용 보호 미디어(DRM)만 허용합니다.
                final List<String> granted = new ArrayList<>();
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID.equals(resource)) granted.add(resource);
                }
                runOnUiThread(() -> {
                    if (granted.isEmpty()) request.deny();
                    else request.grant(granted.toArray(new String[0]));
                });
            }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else if (!handleCallback(getIntent())) {
            web.loadUrl(HOME);
        }
    }

    /** crossfade://callback?code=...&state=app.xxx 로 돌아오면 "app." 을 떼고 크로스페이드에 넘깁니다. */
    private boolean handleCallback(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"crossfade".equals(data.getScheme()) || !"callback".equals(data.getHost())) return false;
        String state = data.getQueryParameter("state");
        if (state != null && state.startsWith(APP_MARK)) data = withState(data, state.substring(APP_MARK.length()));
        String query = data.getEncodedQuery();
        web.loadUrl(HOME + (query == null ? "" : "?" + query));
        return true;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleCallback(intent);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        // 뒤로 가기: 웹 화면 안에서 뒤로 갈 곳이 있으면 가고, 없으면 앱을 끄지 않고 뒤로 보냅니다.
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
