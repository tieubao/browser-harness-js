# dvc-cutru (dichvucong.dancuquocgia.gov.vn)

The Bộ Công an residence portal: đăng ký tạm trú, gia hạn tạm trú and the other cư trú
procedures. It is where a ward's residence services actually run; the national portal
(dichvucong.gov.vn) lists the procedure but for some wards answers "đang chuẩn hóa dịch vụ
công" and cannot take the filing. Entry is through dichvucong.bocongan.gov.vn, which redirects
to VNeID SSO (sso.dancuquocgia.gov.vn) when logged out. The login (QR or password + OTP) stays
with the human; every tool returns `{stop: "login-needed"}` instead of touching that page.

```js
await learnings("dvc-cutru")
await learnings("dvc-cutru", "open", { procedure: "TAMTRU_02" })
await learnings("dvc-cutru", "status")
await learnings("dvc-cutru", "fill", household)
await learnings("dvc-cutru", "attach", { attachments: household.attachments })
await learnings("dvc-cutru", "draft")
await learnings("dvc-cutru", "printCt01", { dir: "/abs/dir" })
await learnings("dvc-cutru", "submit")
```

## The form (dang-ky-tam-tru.html)

jQuery + bootstrap-table, ids stable across procedures. The declarer is auto-filled from the
citizen database when `chkIS_REPORTER` is ticked (name, DOB, ID, and the chủ hộ block). Members
are inline rows `*_CUNGTD<i>` added with `a.add_CUNGTD`; the "THÊM MỚI NGƯỜI TẠM TRÚ" buttons
are hidden and never needed. Attachments are rows in `#dossier`: rows 0 and 1 are fixed (CT01,
giấy giới thiệu), `#btnDocument` adds a free-text row. `In CT01` downloads the portal's own CT01
from the form data; attach it as "giấy tờ điện tử" (type 6) next to any handwritten one, since a
ward officer once bounced a filing for lacking the portal-template CT01.

## Limits (learned 2026-09-10)

- **A click from Runtime.evaluate carries no user activation.** `Nộp hồ sơ` opens the payment
  gateway as a new window; a synthetic click is popup-blocked and the portal shows "Gửi hồ sơ
  thất bại. Lỗi không kết nối được đến trang thanh toán". `submit()` clicks by coordinate
  through `Input.dispatchMouseEvent`, which is a real gesture, and reaches
  pay.vietcombank.com.vn. Payment (ATM card or VNPAY/VietQR) is the human's step.
- **The edit view appends one blank member row on load.** `draft()` and `submit()` delete
  blank rows first; a leftover row would file an empty person.
- **File inputs upload on change.** `DOM.setFileInputFiles` triggers the AJAX upload and the
  input reads back 0 files; the row text carries the uploaded names, which is what `attach()`
  checks.
- **select2 selects** need `jQuery(el).trigger("change")`; a plain DOM change event leaves the
  widget stale.
- **Lưu nháp navigates away** to the dossier list; `draft()` reads the G01 code from wherever
  it lands. Reopen with `edit({id})` using the numeric id from `update_hoso_dvc(<id>,2)` on
  the list page (that function needs a real event object, so navigate to
  `dang-ky-tam-tru.html?id=<id>` directly).
- **Household data is PII** and lives in the family-office vault, never in a repo. The
  ops-toolkit script `experiments/explore-distill-replay/code/dvc-cu-tru` is the CLI over
  these tools and reads that JSON.

## Provenance

2026-09-10 household gia hạn tạm trú at Công an Phường An Hải, Đà Nẵng: driven by hand as
scratch snippets in an ops-toolkit session, then frozen here and as the `dvc-cu-tru` script.
