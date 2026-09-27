-- format-callouts.lua
-- Converts GitHub-style blockquote callouts (> [!TIP], > [!IMPORTANT], > [!WARNING], > [!NOTE], > [!CAUTION])
-- into styled LaTeX environments powered by tcolorbox.

local callout_types = {
  TIP = "callouttip",
  NOTE = "calloutnote",
  IMPORTANT = "calloutimportant",
  WARNING = "calloutwarning",
  CAUTION = "calloutcaution"
}

function BlockQuote(el)
  if #el.content == 0 then
    return nil
  end

  local first_block = el.content[1]
  if first_block.tag ~= "Para" and first_block.tag ~= "Plain" then
    return nil
  end
  if #first_block.content == 0 then
    return nil
  end

  local first_inline = first_block.content[1]
  if first_inline.tag == "Str" then
    local kind = first_inline.text:match("^%[!([A-Za-z]+)%]$")
    if kind then
      local env_name = callout_types[kind:upper()] or "calloutnote"

      -- Remove the [!TYPE] marker
      table.remove(first_block.content, 1)

      -- Remove following Space or SoftBreak if present
      if #first_block.content > 0 and (first_block.content[1].tag == "Space" or first_block.content[1].tag == "SoftBreak") then
        table.remove(first_block.content, 1)
      end

      local begin_tex = pandoc.RawBlock("latex", "\\begin{" .. env_name .. "}")
      local end_tex = pandoc.RawBlock("latex", "\\end{" .. env_name .. "}")

      local result = { begin_tex }
      for _, b in ipairs(el.content) do
        table.insert(result, b)
      end
      table.insert(result, end_tex)
      return result
    end
  end

  return nil
end
