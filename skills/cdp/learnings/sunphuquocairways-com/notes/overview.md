# sunphuquocairways-com (Sun PhuQuoc Airways online check-in)

Notes only, no tools. Hosts: `www.sunphuquocairways.com` (marketing site, check-in entry), `fly.sunphuquocairways.com` (check-in app, paths under `/ssci/`), `checkin.si.amadeus.net` (Apple Wallet pass download). UI is Vietnamese (`/vn/vi`). Everything below ran in Helium with the guarded Page API plus raw CDP.

STOP RULE: never buy extras, never change the seat or the booking, never press "Gỡ check-in". Skip every upsell with "Tiếp tục".

## Connect and isolate

- `DevToolsActivePort` was stale (the browser id in it did not match). Read `http://127.0.0.1:9222/json/version` and use `webSocketDebuggerUrl` as the `wsUrl`.
- The default daemon was already attached through the extension relay, and `browser.connect({wsUrl})` refused to switch. A second daemon worked: set `CDP_REPL_PORT`, `CDP_REPL_PID_FILE`, `CDP_REPL_LOG` to new values for every call, then `--stop` it at the end.
- Isolate with `Target.createBrowserContext`, then `Target.createTarget({browserContextId, background:true})`. Dispose the context at the end.
- Call `Emulation.setFocusEmulationEnabled({enabled:true})` on the target so a locked screen does not matter.
- The check-in flow leaves `www.` and lands on `fly.`. The guarded API then throws `origin_denied`. Re-attach with `fly.sunphuquocairways.com` added to `allowedOrigins`.
- Plain `curl` to the check-in links is reported to hit an Imperva bot wall (told to me, not tested by me). Use the browser.

## Check-in entry and retrieve form

- Info pages: `/vn/vi/travel-info/check-in`, `/check-in/online` (rules), `/check-in/website` (steps). Window: 24 hours to 1 hour before departure.
- The red "LÀM THỦ TỤC" button on `/check-in/website` links to `/vn/vi/?deeplinks=pmb&mode=popup`. Open that URL directly. Wait a few seconds; a snapshot taken during load throws "Page changed while reading".
- It opens a dialog with tabs "Đặt vé", "Quản lý đặt chỗ", "Làm thủ tục", "Lịch bay". The page opens on "Đặt vé".
- Click the `li` whose text is "Làm thủ tục". A JS `element.click()` on the `li` worked here.
- Form: textbox "Mã đặt chỗ" (booking code), textbox "Họ" (last name only, one word), button "Tìm kiếm". `getByRole('textbox',{name}).fill(...)` verified both.
- Submit goes to `fly.sunphuquocairways.com/ssci/journey-selection`.

## Screens in order

1. `/ssci/journey-selection`: "Hành trình chờ làm thủ tục" with a line "Làm thủ tục trực tuyến sẽ đóng trong N giờ và M phút". Click button "Làm thủ tục".
2. `/ssci/passenger-selection`: "Chọn hành khách làm thủ tục". The passenger checkbox was already checked. E-mail, country code and phone were prefilled from the booking. No passport data was asked. Click "Tiếp tục".
3. `/ssci/dangerous-goods`: "Khuyến cáo về Hành lý". This is the normal declaration. Click "Tôi đồng ý và tiếp tục".
4. `/ssci/services/seatmap/<flight>-<date>/0`: banner "Quý khách đã làm thủ tục thành công!" already shows here, so check-in is done at this step. The seat map showed the paid seat as "được chọn cho hành khách". Do not click any seat. Click "Xác nhận chỗ ngồi và tiếp tục".
5. `/ssci/catalog`: "Khám phá các dịch vụ bổ sung" with buttons "Thêm hành lý", "Thêm vé Sun World", "Thêm phòng chờ", "Thêm dịch vụ" (each shows a price). Skip by clicking only "Tiếp tục".
6. `/ssci/overview`: "Quý khách đã làm thủ tục trực tuyến thành công!", "Hãy ghi nhớ giờ lên máy bay!" with "Giờ lên máy bay" (boarding time, 40 minutes before departure in the one case seen). Buttons: "Xem thẻ lên máy bay". Links here include "Gỡ check-in" (undoes check-in, do not click).

## Boarding pass page

- `/ssci/boarding-pass`. Shows route, flight, times, "Giờ lên máy bay", "Cửa" (gate, here "Xem tại bảng điện tử"), seat, group, a QR image.
- A stored link of the form `/ssci/bp?j=<id>&t=<id>&lang=vi` reopened this page directly in a fresh context (the link came from the coordinator; treat the ids as secrets).
- Buttons: "Hiển thị thông tin thẻ lên máy bay bổ sung", "Tải xuống thẻ lên máy bay", "Gửi thẻ lên máy bay", "Quay lại hành trình".
- Save a copy: `Page.captureScreenshot({format:'png', captureBeyondViewport:true})` and `Page.printToPDF({printBackground:true})`, then write the base64 to disk. Both rendered the pass correctly (PNG checked by eye, PDF not opened).
- I did not click "Tải xuống thẻ lên máy bay".

## Apple Wallet pass

- Under the desktop user agent the page offers only Google Pay ("Save to phone").
- Under an iPhone user agent it adds an `a[target=_blank]` wrapping `img` with `src` ending `/assets/img/wallet/Add_to_Apple_Wallet_rgb_EN.svg` (alt starts "Nhấp vào nút này để thêm thẻ lên máy bay này vào Apple Wallet"). Its `href` is `https://checkin.si.amadeus.net/<code>/bp?id=<id>`.
- Set these BEFORE navigating: `Emulation.setUserAgentOverride` with an iPhone Safari string and `platform:'iPhone'`, and `Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:3,mobile:true})`.
- In-page `fetch(href, {credentials:'include'})` from the `fly.` page failed ("Failed to fetch", cross-origin).
- What worked: `Browser.setDownloadBehavior({behavior:'allow', browserContextId, downloadPath:<empty dir>, eventsEnabled:true})`, then open a second background target in the same context (same iPhone emulation, `checkin.si.amadeus.net` in `allowedOrigins`), and `Page.navigate` it to the href. The file landed in the download dir within seconds, named `bp` with no extension. The tab itself stayed on `about:blank`.
- Rename it to `.pkpass`. `unzip -l` showed a zip with `pass.json`, `manifest.json`, `signature`, icons, logos and `pass.strings` for several locales. `pass.json` had a boarding-pass description and an Aztec barcode. The signature was not verified.

## Email the pass

- On `/ssci/boarding-pass` click "Gửi thẻ lên máy bay". A form opens with checkbox "Gửi qua email ở định dạng PDF".
- Tick the checkbox to reveal the "E-mail" textbox. It was prefilled with the booking email. Click "Gửi thẻ lên máy bay" again.
- Result: back on `/ssci/overview` with "Thẻ lên máy bay đã được gửi thành công." The PDF email arrived in the inbox within a minute.

## Caveats

- Site text says online check-in does not apply to special services (except special meals), infants under 2, pregnant passengers, more than 9 passengers per booking, or bookings with several e-tickets for one journey. Not tested here.
- Inferred, not tested: the flow likely behaves the same for other 9G flights inside the 24 hour window.
