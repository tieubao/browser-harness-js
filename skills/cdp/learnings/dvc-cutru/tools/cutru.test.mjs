// learnings/dvc-cutru/tools/cutru.test.mjs
// Exercises the pure dossier-row parser only; no DOM, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDossierRows } from "./cutru.mjs";

test("xem-ho-so.html row with no Trạng thái: derives status from the type= url and reads the id", () => {
  const rows = [
    {
      text: "G01.863.805-260916-890125\nCơ quan thực hiện:\nCông an Phường An Hải\nThủ tục hành chính:\nĐăng ký tạm trú\nNgày nộp:\n16/09/2026",
      onclick: "get_info_hoso(0);view_hoso_dvc(142890322,2)",
    },
  ];
  const [row] = parseDossierRows(rows, "https://dichvucong.dancuquocgia.gov.vn/portal/p/home/xem-ho-so.html?type=1");
  assert.equal(row.dossier, "G01.863.805-260916-890125");
  assert.equal(row.procedure, "Đăng ký tạm trú");
  assert.equal(row.status, "Chưa gửi");
  assert.equal(row.id, 142890322);
});

test("ho-so.html row keeps its explicit Trạng thái:", () => {
  const rows = [
    {
      text: "G01.111.222-260101-000001\nThủ tục hành chính:\nGia hạn tạm trú\nTrạng thái:\nĐã xử lý",
      onclick: "get_info_hoso(0);view_hoso_dvc(555,3)",
    },
  ];
  const [row] = parseDossierRows(rows, "https://dichvucong.dancuquocgia.gov.vn/portal/p/home/ho-so.html");
  assert.equal(row.status, "Đã xử lý");
  assert.equal(row.id, 555);
});

test("no rows yields an empty list", () => {
  assert.deepEqual(parseDossierRows([], "https://dichvucong.dancuquocgia.gov.vn/portal/p/home/xem-ho-so.html?type=4"), []);
  assert.deepEqual(parseDossierRows(undefined, "x"), []);
});
