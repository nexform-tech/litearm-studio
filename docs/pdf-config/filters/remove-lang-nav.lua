-- remove-lang-nav.lua
-- 1. Strips the top language switcher line (e.g., "[English](...) | **简体中文**")
-- 2. Strips cross-document "请参阅" / "refer to" tip callouts pointing to other .md files
-- 3. Defensively removes relative .md hyperlinks to prevent 404 errors in PDF readers

local removed_lang = false
local first_h1_removed = false

function Header(el)
  if not first_h1_removed and el.level == 1 then
    local text = pandoc.utils.stringify(el)
    if text:find("LiteArm") or text:find("快速上手") or text:find("Quickstart") or text:find("操作手册") or text:find("User Manual") then
      first_h1_removed = true
      return {}
    end
  end
  if first_h1_removed and el.level > 1 then
    el.level = el.level - 1
    return el
  end
end

function Para(el)
  local text = pandoc.utils.stringify(el)
  if not removed_lang then
    if text:find("English") and (text:find("中文") or text:find("|")) then
      removed_lang = true
      return {}
    end
  end
  if text:find("10 分钟内完成") or text:find("under 10 minutes") then
    return {}
  end
end

function BlockQuote(el)
  local text = pandoc.utils.stringify(el)
  -- Remove cross-doc reference callout blocks (e.g. "请参阅 ... QUICKSTART_ZH.md", "refer to ... USER_MANUAL.md")
  if (text:find("请参阅") or text:find("请查阅") or text:find("refer to") or text:find("Refer to"))
     and (text:find("%.md") or text:find("指南") or text:find("手册") or text:find("Manual") or text:find("Guide")) then
    return {}
  end
end

function Link(el)
  -- Defensively strip any relative .md links so clicking them doesn't 404
  if el.target:match("%.md$") or el.target:match("%.md#") then
    return el.content
  end
end
