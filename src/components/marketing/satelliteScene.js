// Satellite presentation adapted from the original FirstKnock prototype.
// All DOM access, listeners, and animation resources belong to this landing page.
export function startSatelliteScene(root) {
  if (!root) return undefined;
  let frameId;

  const NS = 'http://www.w3.org/2000/svg', IW = 2688, IH = 1520;
  const $ = (id) => root.querySelector(`#${id}`);
  const fly = $('fly'), sat = $('sat'), ov = $('ov'), hint = $('hint');
  const L = { state: $('lState'), metro: $('lMetro'), region: $('lRegion'), wide: $('lWide'), tight: $('lTight'), ov };
  const dots = [...root.querySelectorAll('#steps i')];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const ss = (v) => { v = clamp01(v); return v * v * (3 - 2 * v); };
  const band = (a, b, v) => ss((v - a) / (b - a));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeBack = (t) => { t = clamp01(t); const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  const el = (tag, attrs = {}, parent = ov) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; };

  const io = new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle('in', e.isIntersecting)), { root, threshold: 0.35 });
  root.querySelectorAll('section .col').forEach((c) => io.observe(c));

  /* ---- how the three views nest, measured on the images (all in region px) ----
     wide sits in the region at 0.19 scale (the fountain pond lines up); tight sits in wide at 0.596 (the house lines up) */
  const K2 = 0.19, K1 = 0.596;
  const RW = { x: 766 * 1.344 - 0, y: 460 * 1.344, w: IW * K2, h: IH * K2 };
  const TW = { x: 535, y: 286, w: IW * K1, h: IH * K1 }; // tight inside wide, wide px
  const RT = { x: RW.x + TW.x * K2, y: RW.y + TW.y * K2, w: TW.w * K2, h: TW.h * K2 };
  // the region sits in the market view at 0.31 scale (river, interchange and the oval subdivision line up)
  const K3 = 0.31, RR = { x: 681 * 1.344, y: 398 * 1.344, w: IW * K3, h: IH * K3 };
  const inM = (r) => ({ x: RR.x + r.x * K3, y: RR.y + r.y * K3, w: r.w * K3, h: r.h * K3 });
  const RWm = inM(RW), RTm = inM(RT);
  // and the market sits in the wider regional view at 0.43 scale (airport, lake and interchange line up): ~5x the area
  const K4 = 0.43, RS = { x: 0, y: 0, w: IW, h: IH }, RMs = { x: 567 * 1.344, y: 305 * 1.344, w: IW * K4, h: IH * K4 };
  const inS = (r) => ({ x: RMs.x + r.x * K4, y: RMs.y + r.y * K4, w: r.w * K4, h: r.h * K4 });
  const RRs = inS(RR), RWs = inS(RWm), RTs = inS(RTm);
  const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];

  /* ---- the region map (region px) ---- */
  const S = (x, y) => [x * 1.344, y * 1.344];
  // the market: a ~650 sq mi boundary around the greater metro (traced on the widest satellite)
  const BOUNDARY = [[180, 180], [900, 60], [1650, 90], [1930, 350], [1900, 800], [1650, 1060], [1000, 1100], [380, 1060], [90, 800], [80, 420]].map(([x, y]) => S(x, y));
  // ~600 leads, sampled across every developed area inside the boundary (lakes, river, airport, rail yard, quarry, industrial parks and interstates excluded)
  const ROOFS = [[329.2, 724.0], [222.6, 616.5], [2493.7, 795.0], [1228.2, 780.9], [842.6, 397.8], [710.0, 1020.8], [1409.1, 380.6], [1199.6, 1461.7], [1908.5, 1383.3], [2133.9, 527.1], [1736.3, 478.2], [209.3, 983.3], [1517.8, 1304.2], [669.7, 537.5], [580.7, 1301.9], [1301.9, 466.3], [1592.9, 1113.9], [780.5, 1405.0], [1176.9, 806.4], [1174.6, 831.8], [2312.7, 963.8], [1172.5, 1216.6], [1195.9, 1030.0], [1607.5, 1357.3], [1035.6, 976.7], [1953.8, 845.0], [137.7, 961.3], [891.2, 574.0], [983.3, 712.1], [368.3, 692.2], [1299.7, 879.9], [2527.3, 807.6], [1387.2, 1140.2], [1825.3, 980.6], [1726.5, 121.5], [1098.3, 854.2], [2340.8, 382.0], [398.5, 667.4], [1290.5, 1019.0], [234.3, 1170.2], [1922.2, 863.1], [1416.3, 694.1], [1907.8, 915.5], [701.8, 173.2], [1554.2, 545.5], [391.7, 880.1], [1687.3, 1174.6], [2317.7, 1021.3], [552.7, 1286.1], [120.3, 801.5], [648.9, 1323.9], [1606.3, 1304.3], [1152.3, 444.6], [1128.4, 756.7], [1276.5, 1469.0], [1373.1, 1100.8], [2559.6, 966.4], [1975.2, 426.4], [555.3, 881.9], [1101.6, 736.0], [1508.4, 1254.4], [2039.5, 268.9], [2045.5, 575.1], [1983.2, 271.8], [1313.0, 430.9], [297.2, 1039.4], [1057.2, 729.9], [1756.2, 998.2], [1567.1, 418.0], [1201.3, 486.7], [1375.7, 941.4], [273.5, 1124.8], [2272.8, 568.3], [1419.6, 1217.9], [2273.5, 521.9], [2356.6, 291.6], [1981.5, 1419.8], [1056.5, 889.9], [2039.3, 874.6], [608.0, 592.9], [848.6, 682.6], [1267.3, 1408.6], [1773.2, 403.8], [1057.7, 361.4], [1380.2, 992.7], [296.6, 1145.0], [1282.3, 856.4], [1259.5, 1139.4], [416.8, 892.7], [738.4, 988.3], [464.1, 1316.5], [2071.3, 872.1], [234.7, 910.8], [2381.2, 561.7], [1772.5, 1152.4], [1262.1, 1432.5], [987.3, 1034.3], [677.1, 1335.1], [1987.5, 196.4], [1826.4, 867.8], [289.7, 471.8], [795.7, 1348.3], [193.3, 1002.7], [1595.5, 928.5], [2514.4, 1067.0], [1772.6, 1030.3], [859.2, 582.8], [2001.5, 710.0], [1314.4, 818.4], [2121.6, 240.4], [274.7, 1166.6], [1688.2, 1305.6], [1091.2, 521.9], [1397.1, 1201.0], [1578.9, 1393.3], [1947.4, 797.3], [356.1, 673.4], [262.7, 1094.4], [653.7, 763.5], [1915.5, 617.3], [1471.0, 1279.9], [2360.2, 335.1], [1639.3, 1179.6], [1915.4, 589.5], [1408.8, 413.5], [172.7, 929.5], [1184.6, 1081.5], [1561.8, 377.0], [592.3, 1273.2], [184.1, 1095.2], [1189.0, 433.9], [757.2, 1346.0], [1127.0, 723.4], [659.3, 178.0], [714.9, 1357.3], [378.3, 656.1], [1747.2, 111.9], [1405.9, 188.5], [1242.6, 672.5], [2329.1, 989.4], [2142.7, 703.7], [1598.6, 1082.8], [1109.8, 121.5], [1292.4, 1420.5], [1869.3, 1348.8], [1075.6, 1114.0], [730.4, 1338.3], [623.5, 544.3], [2222.6, 555.4], [2128.1, 328.6], [1454.3, 321.4], [1878.6, 910.1], [529.8, 1167.5], [835.7, 1424.4], [1913.6, 1353.7], [1292.5, 209.5], [1374.6, 850.9], [1370.3, 792.5], [1420.3, 217.0], [1393.4, 539.5], [523.8, 486.1], [1022.9, 813.5], [1201.3, 738.7], [2430.2, 456.9], [1035.5, 1126.5], [853.4, 552.6], [428.1, 321.4], [1020.4, 1028.1], [1440.9, 771.0], [1365.7, 1389.7], [1301.2, 785.3], [2199.1, 200.5], [338.5, 504.4], [1241.6, 884.6], [2310.2, 870.6], [967.0, 1084.8], [194.2, 649.1], [309.2, 851.6], [362.1, 1079.9], [2162.4, 495.3], [1929.1, 248.6], [2208.0, 931.5], [1156.6, 789.2], [1396.6, 1367.0], [424.3, 703.3], [1000.0, 808.2], [418.9, 1160.0], [348.4, 762.4], [1077.5, 1174.0], [1063.0, 911.1], [966.4, 1150.2], [233.7, 972.6], [1530.8, 521.2], [1535.8, 488.0], [1028.3, 835.2], [1787.5, 447.7], [1770.4, 865.8], [1878.0, 1016.4], [208.4, 938.1], [1945.5, 521.8], [1232.3, 1466.9], [2068.4, 819.2], [1192.7, 1262.5], [1974.3, 480.1], [280.8, 1211.5], [2216.4, 494.7], [290.5, 1061.6], [1906.3, 301.9], [729.3, 454.2], [1060.2, 778.3], [1264.6, 188.4], [1934.0, 1308.7], [1152.6, 753.0], [1802.6, 144.7], [903.0, 543.9], [1572.0, 1132.2], [256.8, 810.4], [2070.4, 1015.8], [1226.5, 744.5], [587.9, 1371.7], [1198.6, 160.4], [1234.6, 913.9], [1103.9, 381.5], [1025.6, 384.8], [2113.2, 347.4], [1191.4, 1051.7], [1386.8, 507.3], [1762.0, 942.0], [1620.5, 1087.9], [1886.6, 634.2], [293.1, 835.2], [1010.3, 697.2], [2083.3, 725.8], [266.6, 881.3], [1853.6, 636.4], [879.3, 355.1], [2009.8, 512.7], [1441.7, 1219.8], [1407.0, 945.3], [704.2, 200.2], [1279.7, 431.6], [308.8, 786.4], [1645.7, 149.8], [326.1, 1056.4], [985.4, 1255.3], [1366.9, 538.4], [512.8, 875.2], [757.2, 1373.8], [2337.8, 408.4], [1043.1, 1276.1], [2399.3, 805.5], [880.8, 675.4], [1928.6, 924.7], [2008.4, 1187.0], [965.5, 813.2], [1631.5, 985.1], [1219.8, 998.3], [1559.2, 1073.2], [1624.6, 535.0], [465.8, 1006.2], [2029.7, 1007.9], [630.3, 1260.4], [1395.9, 280.5], [294.6, 760.1], [2035.6, 193.7], [1567.9, 976.5], [396.9, 700.0], [2067.7, 286.9], [2332.0, 1039.4], [1430.9, 420.0], [614.2, 518.8], [1515.0, 497.6], [1650.7, 1320.8], [163.5, 959.5], [1438.2, 563.2], [1048.7, 108.8], [592.3, 577.2], [2159.9, 885.7], [1348.5, 819.4], [923.8, 1076.3], [407.5, 1076.0], [1363.7, 910.4], [1734.5, 1288.6], [1016.7, 558.6], [2076.5, 648.9], [361.1, 725.9], [2519.0, 985.0], [792.6, 798.1], [1263.2, 874.0], [299.9, 1101.5], [1621.2, 1207.4], [1485.1, 131.1], [816.5, 1372.8], [2066.6, 549.0], [2534.0, 1049.9], [2354.0, 1083.4], [2038.2, 619.6], [2158.5, 585.1], [860.0, 1379.0], [1259.0, 463.5], [1343.9, 326.7], [1223.7, 468.2], [233.3, 582.0], [2255.7, 537.3], [1788.5, 1427.7], [2200.8, 443.6], [1277.9, 824.9], [891.7, 511.4], [2378.7, 498.7], [2128.2, 658.3], [254.5, 1156.4], [2070.2, 615.4], [640.2, 560.0], [589.7, 627.6], [1594.1, 1415.7], [1400.8, 1230.8], [1044.1, 1204.1], [572.3, 719.9], [1687.9, 744.9], [1784.5, 694.5], [1066.0, 974.1], [2301.7, 941.0], [1234.4, 1425.0], [1565.5, 1415.6], [1929.1, 835.3], [437.7, 615.6], [2549.6, 748.7], [698.0, 547.2], [875.7, 987.4], [187.7, 606.0], [1336.4, 487.2], [1148.6, 1253.5], [336.4, 466.0], [2017.0, 608.0], [133.8, 529.9], [1982.5, 160.0], [1918.0, 206.0], [1458.1, 466.1], [1075.8, 745.2], [1325.3, 1017.7], [2334.1, 299.3], [1538.6, 425.9], [834.5, 1145.6], [1326.4, 698.9], [2103.2, 324.8], [2263.2, 659.5], [1665.8, 106.0], [1728.2, 1254.9], [393.2, 725.2], [298.1, 441.9], [1254.6, 1464.7], [1562.6, 463.8], [1099.9, 1223.3], [2339.4, 519.9], [893.8, 1369.7], [1352.2, 1065.3], [601.9, 1316.8], [1770.9, 631.7], [1390.1, 472.9], [795.9, 153.0], [247.7, 1120.1], [559.7, 666.7], [937.8, 737.5], [2114.5, 545.2], [550.2, 611.3], [1911.8, 537.2], [1422.2, 898.9], [2067.7, 795.2], [1696.6, 378.9], [930.9, 972.8], [2395.7, 468.3], [1890.7, 441.4], [2360.4, 438.5], [1355.6, 292.0], [1717.5, 285.5], [1544.3, 287.4], [1290.2, 709.2], [141.7, 909.8], [1270.8, 895.2], [838.4, 708.3], [1021.5, 1256.2], [428.7, 649.5], [878.9, 530.3], [308.5, 604.6], [2055.7, 731.2], [1170.9, 1465.6], [1371.5, 422.1], [1957.9, 604.4], [1632.9, 959.2], [1503.2, 1041.2], [2048.1, 598.3], [1198.1, 1099.7], [2357.6, 491.8], [613.1, 1280.5], [1049.7, 1039.0], [2565.3, 872.0], [1355.3, 931.9], [1554.9, 1274.2], [1943.7, 583.2], [2010.4, 867.4], [1875.7, 655.5], [750.1, 1278.6], [1263.8, 235.1], [1448.4, 1449.7], [1968.7, 1278.6], [2074.1, 695.9], [536.1, 1301.6], [1130.6, 653.0], [1025.3, 762.9], [1807.7, 851.6], [1648.1, 249.6], [2304.2, 996.0], [795.6, 1384.4], [1198.5, 406.3], [1180.6, 1113.4], [1217.9, 1445.1], [2150.5, 557.1], [723.1, 1316.2], [1375.7, 391.0], [2216.2, 662.2], [1085.0, 648.2], [1249.1, 978.8], [367.6, 256.3], [738.0, 406.9], [361.9, 894.9], [814.3, 1041.3], [506.4, 1054.3], [1145.4, 881.9], [1375.8, 301.8], [1264.7, 1173.4], [1473.0, 1055.9], [1791.4, 881.3], [1027.1, 1168.3], [524.6, 1090.3], [1495.9, 1315.7], [181.3, 1042.2], [2190.9, 751.2], [1337.7, 424.9], [1465.4, 187.5], [1202.3, 788.1], [1250.2, 1086.8], [1614.1, 238.9], [205.2, 1087.8], [2316.5, 846.4], [247.7, 929.8], [2025.5, 442.0], [746.9, 213.6], [980.6, 1368.7], [2242.0, 588.7], [1743.8, 1020.6], [1600.4, 525.5], [2077.6, 901.8], [519.7, 1134.1], [1039.2, 210.8], [1350.4, 630.1], [1499.0, 1100.3], [1915.6, 693.6], [1419.5, 147.8], [1717.0, 526.1], [239.0, 831.7], [1336.5, 948.8], [1415.8, 1382.8], [1159.7, 466.5], [1775.6, 921.8], [730.8, 1009.3], [1853.8, 1416.7], [801.4, 763.1], [1461.1, 1014.5], [861.7, 1143.5], [2095.9, 985.6], [1415.9, 544.5], [534.1, 1037.7], [1540.8, 1294.2], [2401.0, 351.8], [1750.8, 1142.6], [976.1, 271.2], [2354.6, 362.7], [265.3, 751.2], [325.0, 631.0], [1096.8, 820.1], [943.1, 543.0], [1569.5, 1167.6], [1522.4, 142.5], [689.6, 467.5], [1642.5, 388.6], [2362.8, 635.0], [2503.8, 773.4], [2099.1, 878.7], [689.8, 1370.1], [2383.7, 448.6], [1384.2, 899.0], [2266.9, 698.6], [978.4, 594.3], [1518.2, 734.8], [483.7, 1192.9], [189.0, 1072.5], [2169.6, 1415.8], [1332.9, 553.9], [1428.2, 446.6], [756.8, 627.6], [2303.3, 904.9], [853.6, 729.8], [1764.6, 515.3], [364.6, 494.4], [807.6, 617.7], [2132.5, 881.0], [571.8, 567.3], [466.3, 653.8], [1483.1, 1343.6], [2552.2, 988.5], [761.1, 548.1], [1415.6, 251.7], [1614.9, 126.3], [1535.2, 777.9], [2104.8, 658.2], [606.4, 1089.1], [335.0, 790.8], [2220.1, 525.0], [1481.1, 1232.0], [208.8, 908.0], [1468.1, 1098.5], [1664.2, 1427.8], [2422.8, 1148.4], [317.0, 1124.6], [1978.7, 726.4], [1745.5, 545.9], [297.1, 493.6], [2239.2, 975.7], [2027.0, 240.1], [1393.3, 251.9], [974.7, 791.2], [2181.1, 876.4], [594.9, 1054.4], [1490.3, 272.0], [2505.5, 870.6], [134.6, 767.8], [628.7, 1333.4], [993.3, 838.9], [2127.7, 304.7], [535.3, 641.6], [346.0, 564.2], [223.5, 891.6], [1900.4, 276.1], [184.2, 981.7], [1906.5, 954.4], [113.9, 738.1], [1881.1, 296.7], [2086.0, 356.5], [1102.8, 300.4], [1644.4, 1393.3], [919.6, 258.5], [1245.0, 860.0], [166.9, 1058.9], [1388.7, 370.0], [908.5, 781.2], [1184.5, 755.3], [1724.7, 190.0], [119.6, 546.9], [425.9, 1187.2], [127.5, 580.2], [1534.1, 386.4], [1495.8, 1202.0], [1107.9, 652.4], [726.2, 192.3], [2016.3, 413.8], [1423.8, 756.7], [1399.5, 921.0], [994.0, 1056.4], [2096.8, 239.2], [964.7, 355.8], [1262.7, 1003.3], [1522.1, 1127.3], [1959.8, 1342.0], [1627.7, 1021.8], [356.6, 646.8], [1290.3, 180.1], [485.9, 1162.2], [2055.7, 1405.8], [529.9, 573.3], [1579.7, 1365.6], [484.7, 901.3], [1390.5, 1115.3], [2044.7, 835.5], [1297.5, 414.0], [817.8, 1442.1], [1930.4, 761.6], [2489.3, 885.7], [1298.2, 735.6], [1453.3, 431.7], [695.0, 1037.8], [1159.6, 1137.4], [2310.8, 789.2], [468.1, 560.2], [1126.4, 864.7], [468.2, 1289.7], [1349.0, 1021.0], [347.7, 1116.7], [834.8, 505.6], [1024.4, 670.3], [265.9, 673.4], [2395.1, 1120.6], [1574.6, 1100.9], [1014.4, 1137.5], [1584.2, 1315.2], [1817.2, 1147.3], [1136.7, 263.9], [1601.5, 1005.6], [2192.7, 481.3], [2164.8, 620.6], [1222.3, 496.7], [1583.9, 1249.8], [1431.6, 348.7]];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const inside = (q, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > q[1]) !== (yj > q[1]) && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
  function spread(pts, k) { const out = [pts.reduce((a, p) => (p[0] < a[0] ? p : a))]; while (out.length < k) out.push(pts.reduce((best, p) => { const d = Math.min(...out.map((o) => dist(o, p))); return d > best.d ? { p, d } : best; }, { p: null, d: -1 }).p); return out; }
  function tour(pts, first) {
    const left = pts.slice(), o = [left.splice(left.indexOf(first || left.reduce((a, p) => (p[0] < a[0] ? p : a))), 1)[0]];
    while (left.length) { const l = o[o.length - 1]; let bi = 0; left.forEach((p, i) => { if (dist(p, l) < dist(left[bi], l)) bi = i; }); o.push(left.splice(bi, 1)[0]); }
    for (let improved = true; improved;) { improved = false; for (let i = 0; i < o.length - 2; i++) for (let j = i + 2; j < o.length - 1; j++) { if (dist(o[i], o[i + 1]) + dist(o[j], o[j + 1]) > dist(o[i], o[j]) + dist(o[i + 1], o[j + 1]) + 1e-6) { o.splice(i + 1, j - i, ...o.slice(i + 1, j + 1).reverse()); improved = true; } } }
    return o;
  }
  // group the leads into five balanced patches (capacity-limited k-means), then build the one route patch by patch,
  // so cutting it into five equal runs gives every rep one clean, connected area
  function powerSplit(pts, k) {
    let C = spread(pts, k), Wt = new Array(k).fill(0), A = [];
    const assign = () => pts.map((p) => { let bj = 0, bv = Infinity; C.forEach((c, j) => { const v = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 - Wt[j]; if (v < bv) { bv = v; bj = j; } }); return bj; });
    for (let it = 0; it < 15; it++) { A = assign(); C = C.map((c, j) => { const m = pts.filter((_, i) => A[i] === j); return m.length ? centroid(m) : c; }); } // settle the centres
    const target = pts.length / k;
    for (let it = 0; it < 400; it++) { A = assign(); const n = new Array(k).fill(0); A.forEach((j) => n[j]++); if (Math.max(...n) - Math.min(...n) <= 2) break; Wt = Wt.map((w, j) => w + (target - n[j]) * 300); }
    return { C, Wt, groups: C.map((c, j) => ({ c, j, pts: pts.filter((_, i) => A[i] === j) })) };
  }
  function tourFrom(pts, start) { const s0 = pts.reduce((a, p) => (dist(p, start) < dist(a, start) ? p : a)); const rest = pts.filter((p) => p !== s0); return tour([s0, ...rest], s0); }
  const centroid = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  const SPLIT = powerSplit(ROOFS.filter((q) => inside(q, BOUNDARY)), 5);
  const PATCHES = (() => { const order = tour(SPLIT.groups.map((q) => q.c)); return order.map((c) => SPLIT.groups.find((q) => q.c === c)); })();
  const RUNS = []; PATCHES.forEach((q, i) => RUNS.push(tourFrom(q.pts, i ? RUNS[i - 1][RUNS[i - 1].length - 1] : [0, 0])));
  const LEADS = RUNS.flat(); // one route through every lead, in visiting order
  const REPS = [{ c: '#39ff4a', n: '#1' }, { c: '#ff3d6e', n: '#2' }, { c: '#ff8a1f', n: '#3' }, { c: '#8a63ff', n: '#4' }, { c: '#ff4fd8', n: '#5' }];
  // the split: cut that one route into five contiguous runs of equal size, so every stop is accounted for exactly once
  const CHUNKS = RUNS;
  const repOf = RUNS.flatMap((r, i) => r.map(() => i));
  const toD = (pts, close) => 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L') + (close ? ' Z' : '');
  $('nstops').textContent = LEADS.length;
  $('lgRows').innerHTML = REPS.map((r, i) => `<div class="lg-r"><i style="background:${r.c}"></i>Rep ${i + 1}<span>${CHUNKS[i].length} stops</span></div>`).join('');
  $('lgTotal').textContent = `${LEADS.length} / ${LEADS.length}`;

  /* ---- overlay ---- */
  const defs = el('defs');
  // team territories: a soft blob grown around each rep's homes, with a crisp edge (gooey threshold + outline)
  const hug = el('filter', { id: 'hug', filterUnits: 'userSpaceOnUse', x: -300, y: -300, width: IW + 600, height: IH + 600 }, defs);
  el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 22, result: 'b' }, hug);
  el('feColorMatrix', { in: 'b', type: 'matrix', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 28 -11', result: 'goo' }, hug);
  el('feMorphology', { in: 'goo', operator: 'dilate', radius: 3, result: 'grow' }, hug);
  el('feComposite', { in: 'grow', in2: 'goo', operator: 'out', result: 'edge' }, hug);
  const ct = el('feComponentTransfer', { in: 'goo', result: 'soft' }, hug); el('feFuncA', { type: 'linear', slope: 0.2 }, ct);
  const mg = el('feMerge', {}, hug); el('feMergeNode', { in: 'soft' }, mg); el('feMergeNode', { in: 'edge' }, mg);

  // the drawn area
  const gPoly = el('g', { opacity: 0 });
  const poly = el('path', { class: 'poly', d: toD(BOUNDARY, true) }, gPoly);
  const polyLen = poly.getTotalLength();
  poly.style.strokeDasharray = polyLen; poly.style.fillOpacity = 0;
  const tag = el('g', { class: 'tag', opacity: 0 }, gPoly), ta = BOUNDARY[2];
  el('rect', { x: ta[0] - 102, y: ta[1] - 70, width: 204, height: 48, rx: 8 }, tag);
  el('text', { x: ta[0] - 72, y: ta[1] - 37 }, tag).textContent = '~650 sq mi';

  // team territories sit under everything else
  // team areas: Canvas splits the whole market, each rep owning the part of the boundary closest to their own stops
  function clipHalf(poly, side) { // keep the part of poly where side(q) <= 0
    const out = [];
    poly.forEach((a, i) => { const b = poly[(i + 1) % poly.length], sa = side(a), sb = side(b);
      if (sa <= 0) out.push(a);
      if ((sa <= 0) !== (sb <= 0)) { const t = sa / (sa - sb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); } });
    return out;
  }
  // each rep's area: the part of the market where they are the nearest (weighted) team, so the colours tile the whole market with no gaps
  const CELLS = PATCHES.map((g) => {
    const ci = SPLIT.C[g.j], wi = SPLIT.Wt[g.j];
    let cell = BOUNDARY.slice();
    SPLIT.C.forEach((cj, j) => { if (j === g.j) return; const wj = SPLIT.Wt[j];
      cell = clipHalf(cell, (q) => 2 * (q[0] * (cj[0] - ci[0]) + q[1] * (cj[1] - ci[1])) - (cj[0] ** 2 + cj[1] ** 2 - ci[0] ** 2 - ci[1] ** 2) + (wj - wi)); });
    return cell;
  });
  const territories = REPS.map((r, i) => el('path', { d: toD(CELLS[i], true), fill: 'none', stroke: 'none', opacity: 0 }) /* areas still define the split; only the coloured routes and stops are drawn */);

  // one route through every lead, drawn as a dotted line revealed by a mask
  const mask = el('mask', { id: 'rm', maskUnits: 'userSpaceOnUse', x: -500, y: -500, width: IW + 1000, height: IH + 1000 }, defs);
  const maskPath = el('path', { d: toD(LEADS), fill: 'none', stroke: '#fff', 'stroke-width': 20, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, mask);
  const runLen = maskPath.getTotalLength();
  maskPath.style.strokeDasharray = runLen; maskPath.style.strokeDashoffset = runLen;
  const runPath = el('path', { d: toD(LEADS), fill: 'none', stroke: '#39ff4a', 'stroke-width': 3, 'stroke-dasharray': '0.1 8', 'stroke-linecap': 'round', mask: 'url(#rm)', opacity: 0 });
  const stopAt = []; { let acc = 0; LEADS.forEach((p, i) => { if (i) acc += dist(LEADS[i - 1], p); stopAt.push(acc); }); }
  // the same route, cut into each rep's run
  const chunkPaths = CHUNKS.map((c, i) => el('path', { d: toD(c), fill: 'none', stroke: REPS[i].c, 'stroke-width': 3, 'stroke-dasharray': '0.1 8', 'stroke-linecap': 'round', opacity: 0 }));

  // lead dots, on the roofs
  const leadDots = LEADS.map((p) => el('circle', { cx: p[0], cy: p[1], r: 6, fill: '#39ff4a', stroke: '#0d0d0d', 'stroke-width': 2, opacity: 0 }));
  const visitRings = LEADS.map((p) => el('circle', { cx: p[0], cy: p[1], r: 8, fill: 'none', stroke: '#fff', 'stroke-width': 3, opacity: 0 }));

  // the route walker carries a live "stop n / total" tag
  const walker = el('circle', { r: 10, fill: '#eaffee', stroke: '#39ff4a', 'stroke-width': 4, opacity: 0 });
  const wTag = el('g', { class: 'walk-tag', opacity: 0 }); el('rect', { x: 14, y: -44, width: 116, height: 32, rx: 7 }, wTag);
  const wText = el('text', { x: 26, y: -22 }, wTag);

  // per-rep walkers and labels for the team view
  const crew = CHUNKS.map((c, i) => {
    const path = el('path', { d: toD(c), fill: 'none', stroke: 'none' }), len = path.getTotalLength();
    const at = []; { let acc = 0; c.forEach((p, k) => { if (k) acc += dist(c[k - 1], p); at.push(acc); }); }
    const w = el('circle', { r: 10, fill: '#fff', stroke: REPS[i].c, 'stroke-width': 5, opacity: 0 });
    const [cx, cy] = centroid(CELLS[i]);
    const lab = el('g', { class: 'ring', opacity: 0 });
    el('rect', { x: cx - 74, y: cy - 22, width: 148, height: 44, rx: 22, fill: 'rgba(13,13,13,.78)', stroke: REPS[i].c, 'stroke-width': 4 }, lab);
    el('text', { x: cx, y: cy + 1, fill: REPS[i].c, style: 'font-size:21px' }, lab).textContent = `${REPS[i].n} · ${c.length} stops`;
    return { path, len, at, w, lab, first: RUNS.slice(0, i).reduce((s, r) => s + r.length, 0) };
  });

  /* ---- camera: a view rect in region px, applied to every layer ---- */
  let vw = 0, vh = 0, base = 1;
  function layout() { vw = innerWidth; vh = innerHeight; base = Math.max(vw / IW, vh / IH); }
  window.addEventListener('resize', layout); layout();
  function place(layer, rect, cx, cy, zoom) { // rect: where this layer's 2688×1520 image lives, in region px
    const sc = base * zoom, k = (rect.w / IW) * sc;
    layer.style.transform = `translate(${vw / 2 + (rect.x - cx) * sc}px, ${vh / 2 + (rect.y - cy) * sc}px) scale(${k})`;
  }

  let target = 0, cur = 0, leadsAt = null, runAt = null, teamAt = null, last = performance.now(), dur = 8;
  const onMetadata = () => { dur = fly.duration || 8; };
  fly.addEventListener('loadedmetadata', onMetadata);
  // pull the whole clip into memory so scroll-scrubbing can seek anywhere instantly, even on servers without range requests
  const controller = new AbortController();
  let videoUrl;
  // Load on first exploration so the hero appears without downloading a 30 MB clip.
  const loadVideo = () => {
    if (reduce) return;
    fetch('/landing/flyover-lux.mp4', { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Video unavailable'); return response.blob(); })
      .then(blob => {
        if (controller.signal.aborted) return;
        videoUrl = URL.createObjectURL(blob);
        fly.src = videoUrl;
        fly.load();
      }).catch(() => { if (!controller.signal.aborted) fly.src = '/landing/flyover-lux.mp4'; });
  };
  root.addEventListener('scroll', loadVideo, { once: true, passive: true });
  const onScroll = () => { target = root.scrollTop / Math.max(1, innerHeight); hint.classList.toggle('gone', root.scrollTop > 40); };
  root.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  const cT = center(RTs), cW = center(RWs), cR = center(RRs), cM = center(RMs), cS = center(RS);

  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    const now = t / 1000;
    cur += (Math.min(6, target) - cur) * (reduce ? 1 : 1 - Math.pow(0.004, dt));

    // flyover: scroll scrubs the drone shot, then the crisp satellite still takes over
    const want = band(0.08, 1.7, cur) * Math.max(0, dur - 0.05);
    if (fly.readyState >= 2 && Math.abs(fly.currentTime - want) > 1 / 60 && !fly.seeking) fly.currentTime = want;
    sat.style.opacity = band(1.55, 1.75, cur);

    // pull back twice: the street -> the subdivision -> the whole side of town (zoom is relative to the region filling the screen)
    const p1 = band(1.65, 1.9, cur), p2 = band(1.85, 2.12, cur), p3 = band(2.08, 2.38, cur), p4 = band(2.33, 2.68, cur);
    const zT = 1 / (K1 * K2 * K3 * K4), zW = 1 / (K2 * K3 * K4), zR = 1 / (K3 * K4), zM = 1 / K4;
    const lz = lerp(lerp(lerp(lerp(Math.log(zT), Math.log(zW), p1), Math.log(zR), p2), Math.log(zM), p3), 0, p4);
    const zoom = Math.exp(lz); // log-space so the climb feels constant
    const cx = lerp(lerp(lerp(lerp(cT[0], cW[0], p1), cR[0], p2), cM[0], p3), cS[0], p4), cy = lerp(lerp(lerp(lerp(cT[1], cW[1], p1), cR[1], p2), cM[1], p3), cS[1], p4);
    place(L.tight, RTs, cx, cy, zoom); place(L.wide, RWs, cx, cy, zoom); place(L.region, RRs, cx, cy, zoom); place(L.metro, RMs, cx, cy, zoom); place(L.state, RS, cx, cy, zoom); place(L.ov, RS, cx, cy, zoom);
    L.tight.style.opacity = 1 - band(1.7, 1.9, cur);
    L.wide.style.opacity = 1 - band(2.03, 2.22, cur);
    L.region.style.opacity = 1 - band(2.3, 2.47, cur);
    L.metro.style.opacity = 1 - band(2.55, 2.72, cur);
    // only paint what is on stage, so the browser never has to hold a hugely magnified layer
    L.tight.style.visibility = cur < 1.95 ? 'visible' : 'hidden';
    L.wide.style.visibility = cur > 1.6 && cur < 2.27 ? 'visible' : 'hidden';
    L.region.style.visibility = cur > 1.8 && cur < 2.52 ? 'visible' : 'hidden';
    L.metro.style.visibility = cur > 2.0 && cur < 2.77 ? 'visible' : 'hidden';
    L.state.style.visibility = cur > 2.25 ? 'visible' : 'hidden';
    L.ov.style.visibility = cur > 2.7 ? 'visible' : 'hidden';
    const dim = band(2.7, 3, cur);
    const back = 0;
    $('state').style.filter = `brightness(${(1 - 0.28 * dim) * (1 - 0.55 * back)}) saturate(${1 - 0.25 * dim - 0.4 * back}) blur(${back * 3}px)`;
    L.ov.style.opacity = 1 - 0.75 * back;
    const mapOn = band(2.2, 2.6, cur); // once the map is up, no gradients: the same full brightness edge to edge
    $('shadeL').style.opacity = band(0.6, 1.2, cur) * (1 - mapOn);
    $('shadeB').style.opacity = (1 - 0.7 * band(0.3, 1, cur)) * (1 - mapOn);

    // boundary traces itself across town, then fills and shows its size
    const team = band(4.55, 5.1, cur);
    gPoly.setAttribute('opacity', cur > 2.75 ? 1 - 0.85 * team : 0);
    poly.style.strokeDashoffset = polyLen * (1 - (reduce ? 1 : band(2.8, 3.2, cur)));
    const fill = band(3.1, 3.3, cur);
    poly.style.fillOpacity = fill * (1 - 0.6 * team); tag.setAttribute('opacity', fill * (1 - team));

    // leads land on their roofs, then one route threads all of them
    if (cur > 3.35 && leadsAt === null) leadsAt = now; if (cur < 3.15) leadsAt = null;
    if (cur > 3.85 && runAt === null) runAt = now; if (cur < 3.6) runAt = null;
    if (cur > 4.65 && teamAt === null) teamAt = now; if (cur < 4.45) teamAt = null;
    const RD = 8, raw = runAt === null ? 0 : reduce ? 1 : clamp01((now - runAt) / RD);
    const pr = raw < 1 ? 1 - Math.pow(1 - raw, 1.4) * (1 - raw * 0.2) : 1, head = pr * runLen;
    maskPath.style.strokeDashoffset = runLen * (1 - pr);
    runPath.setAttribute('opacity', runAt === null ? 0 : 1 - team);
    let reached = 0;
    LEADS.forEach((p, i) => {
      const a = leadsAt === null ? 0 : reduce ? 1 : easeBack((now - leadsAt - (i % 120) * 0.012 - Math.floor(i / 120) * 0.05) / 0.4);
      const hit = runAt !== null && head >= stopAt[i] - 0.5; if (hit) reached = i + 1;
      const d = leadDots[i];
      d.setAttribute('r', 6 * Math.max(0.001, a)); d.setAttribute('opacity', a > 0.01 ? 1 : 0);
      d.setAttribute('fill', teamAt !== null && now - teamAt > 0.15 * repOf[i] ? REPS[repOf[i]].c : '#39ff4a');
    });
    // a ring pops on each house the moment it is reached
    visitRings.forEach((v, i) => { const t = runAt === null ? 1 : (head - stopAt[i]) / 40; v.setAttribute('r', 8 + 22 * clamp01(t)); v.setAttribute('opacity', team < 0.5 && t > 0 && t < 1 ? (1 - t) * 0.9 : 0); });
    if (runAt !== null && team < 0.99) {
      const q = maskPath.getPointAtLength(raw < 1 ? head : runLen);
      walker.setAttribute('cx', q.x); walker.setAttribute('cy', q.y); walker.setAttribute('opacity', 1 - team);
      wTag.setAttribute('transform', `translate(${q.x} ${q.y})`); wTag.setAttribute('opacity', 1 - team);
      wText.textContent = `Stop ${reached} / ${LEADS.length}`;
    } else { walker.setAttribute('opacity', 0); wTag.setAttribute('opacity', 0); }

    // the split: the one route breaks into each rep's run, territories grow around their homes, and every rep sets off
    const split = (i) => (teamAt === null ? 0 : reduce ? 1 : clamp01((now - teamAt - i * 0.15) / 0.5));
    chunkPaths.forEach((c, i) => c.setAttribute('opacity', split(i) * team));
    territories.forEach((g, i) => g.setAttribute('opacity', split(i) * team));
    crew.forEach((c, i) => {
      const k = split(i) * team;
      c.lab.setAttribute('opacity', k);
      if (k > 0.01) {
        const speed = 70, T = (now - teamAt) * speed, L = c.len, d = T % (2 * L), pos = d < L ? d : 2 * L - d; // walk the run, turn round, repeat
        const q = c.path.getPointAtLength(pos); c.w.setAttribute('cx', q.x); c.w.setAttribute('cy', q.y); c.w.setAttribute('opacity', k);
        c.at.forEach((s0, j) => { const t = (pos - s0) / 30 * (d < L ? 1 : -1); const v = visitRings[c.first + j]; if (t > 0 && t < 1) { v.setAttribute('r', 8 + 20 * t); v.setAttribute('opacity', (1 - t) * 0.9); v.setAttribute('stroke', REPS[i].c); } });
      } else c.w.setAttribute('opacity', 0);
    });
    $('legend').style.opacity = clamp01(team * 1.4 - 0.3) * (1 - back);

    dots.forEach((d, k) => d.classList.toggle('on', Math.min(5, Math.round(cur)) === k));
    frameId = requestAnimationFrame(frame);
  }
  frameId = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(frameId);
    window.removeEventListener('resize', layout);
    root.removeEventListener('scroll', onScroll);
    root.removeEventListener('scroll', loadVideo);
    fly.removeEventListener('loadedmetadata', onMetadata);
    controller.abort();
    fly.pause();
    fly.removeAttribute('src');
    fly.load();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    io.disconnect();
    ov.replaceChildren();
  };
}
