# Эталонные рисунки: проверка и источники

Сетка — 32 шага на восьмёрку (шестнадцатые); счёт c находится на шаге 4·(c−1), «&» = +2. Рисунки, зависящие от клаве, хранятся для одного направления. Для противоположного направления они поворачиваются на один такт (полцикла): ровно так соотносятся 3–2 и 2–3.

Эталон — это **один документированный вариант**, а не единственно возможная партия. Статусы:
- **established** — широко документированный рисунок;
- **simplified** — упрощённая версия реальной партии;
- **illustrative** — сконструированный пример.

| Рисунок | Удары (счета) | Статус | Источники | Проверено тестом |
|---|---|---|---|---|
| Son clave 3–2 | 1, 2&, 4 \| 6, 7 | established | Wikipedia «Clave (rhythm)»; D. Peñalosa, *The Clave Matrix* (2009) | ✅ |
| Son clave 2–3 | 2, 3 \| 5, 6&, 8 | established | то же; поворот 3–2 на такт | ✅ |
| Rumba clave 3–2 | 1, 2&, 4& \| 6, 7 | established | то же: третий удар на 4& | ✅ |
| Rumba clave 2–3 | 2, 3 \| 5, 6&, 8& | established | то же | ✅ |
| Conga tumbao (марча) | слэп 2, открытые 4, 4& в каждом такте; heel/toe тихо на остальных восьмых | established | методики конги (B. Sanabria, T. Salloum) | ✅ |
| Bass tumbao | 2& и 4 в каждом такте; нота на 4 предвосхищает следующую гармонию и лигуется через сильную долю | established | Wikipedia «Tumbao»; Peñalosa | ✅ |
| Campana (bongo bell), 2–3 | открытые 1, 3, 5, 7; закрытые 2, 4, 4&, 6, 6&, 8, 8& (запись `0xcx\|0xcc\|0xcc\|0xcc` по восьмым) | established | [timba.com «Finding the clave»](https://www.timba.com/artist_pages/finding-the-clave); [danceintime.com](https://danceintime.com/info/clave-and-percussion-in-salsa-music) («1 2 3 4& 5 6& 7 8&») | — |
| Timbales cáscara, 2–3 | 1, 2, 3, 3&, 4& \| 5, 6, 6&, 7&, 8& (`x.x.xx.x \| x.xx.x.x`) | established | Wikipedia «Cáscara»; F. Absil, латинские аранжировки ([fransabsil.nl](https://www.fransabsil.nl/archpdf/bandlatn.pdf)) | ✅ (содержит все удары клаве кроме одного) |
| Bongó martillo | ровные восьмые, открытый тон на хембре на 4 | simplified | Wikipedia «Bongo drum» | — |
| Güiro | длинный на 1, 3, 5, 7 + два коротких (четверть + две восьмые, «down–down–up») | established | [Jazz Education Network, Latin percussion applications](https://jazzednet.org/resources/latin-percussion-applications-in-the-jazz-band/); danceintime.com | — |
| Maracas | ровные восьмые, акцент на долях | simplified | общепринятая практика; реальные партии сложнее | — |
| Piano montuno | сконструированное гуахео с упором на слабые доли, I–V | illustrative | Wikipedia «Guajeo»: монтуно индивидуальны для песни | — |

## Танцевальные схемы

| Схема | Шаги / паузы / брейк | Статус | Источники |
|---|---|---|---|
| Salsa On1 | шаги 1-2-3, 5-6-7; паузы 4, 8; брейк на 1 и 5 | established | Wikipedia «Salsa (dance)» |
| Salsa On2 (Eddie Torres, ET2) | шаги 1-2-3, 5-6-7; паузы 4, 8; брейк на 2 и 6 | established | [The Dance Dojo](https://thedancedojo.com/salsa-dance-terms/new-york-style-salsa-on-2/); Salsa Handbook (Medium) |
| Casino | «a tiempo» 1-2-3, 5-6-7 (база guapea) | simplified | — |
| Son | «contratiempo»: шаги 2-3-4, 6-7-8, удержание на 1 и 5 | simplified | [sonycasino.com](https://sonycasino.com/2016/06/03/what-is-the-difference-between-son-and-on2-salsa-timing/) |

Расхождения источников:
- **On2:** источники расходятся в том, с какого счёта начинается базовый шаг и какой ногой. Поэтому ноги для On2 не указаны (`foot: null`), зафиксирован только тайминг. Power On2 (Razz M'Tazz) — другая схема: шаги 2-3-4, 6-7-8.
- **Son:** региональные варианты сильно различаются; схема — одна из гипотез.

## Как добавить рисунок

1. Добавить запись в `src/rhythm/patterns.json` с `source` и `status`.
2. `npm test`: валидация проверит диапазоны, монотонность и уникальность id.
3. Если рисунок известен по нотации, добавить в `tests/patterns.test.ts` проверку ударов по счетам.
4. Добавить строку в таблицу выше.
