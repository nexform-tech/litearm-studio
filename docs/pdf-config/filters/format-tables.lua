-- Convert HTML <br> tags into LaTeX linebreaks (\newline)
function RawInline(el)
  if el.format == "html" and el.text:match("^<[Bb][Rr]%s*/?>$") then
    return pandoc.RawInline("latex", "\\newline ")
  end
end

function Table(el)
  local latex = pandoc.write(pandoc.Pandoc({el}), "latex")

  -- 1. Format column spec to have vertical borders |
  local function format_spec(spec)
    spec = spec:gsub("@{}", "")
    if spec:find("p%b{}") then
      local parts = {}
      for col in spec:gmatch("([^\r\n]+)") do
        local trimmed = col:match("^%s*(.-)%s*$")
        if #trimmed > 0 then
          table.insert(parts, "| " .. trimmed)
        end
      end
      return "\n  " .. table.concat(parts, "\n  ") .. " |"
    else
      local cols = {}
      for c in spec:gmatch("[lcr]") do
        table.insert(cols, c)
      end
      if #cols > 0 then
        return "| " .. table.concat(cols, " | ") .. " |"
      else
        return spec
      end
    end
  end

  -- Find the longtable column spec
  local pre_pos, spec_start = latex:find("\\begin{longtable}", 1, true)
  if pre_pos then
    local brace_start = latex:find("{", spec_start + 1, true)
    local toprule_pos = latex:find("\\toprule", brace_start, true)
    if brace_start and toprule_pos then
      -- The column spec is between brace_start and the last '}' before toprule_pos
      local before_toprule = latex:sub(brace_start, toprule_pos - 1)
      local last_brace = before_toprule:match(".*()%}")
      if last_brace then
        local raw_spec = before_toprule:sub(2, last_brace - 1)
        local formatted = format_spec(raw_spec)
        latex = latex:sub(1, brace_start) .. formatted .. latex:sub(brace_start + last_brace - 1)
      end
    end
  end

  -- 2. Replace toprule with \hline and header background
  latex = latex:gsub("\\toprule%s*\\noalign{}", "\\hline\n\\rowcolor{tableheaderbg}")
  latex = latex:gsub("\\toprule", "\\hline\n\\rowcolor{tableheaderbg}")

  -- 3. Replace midrule with \hline
  latex = latex:gsub("\\midrule%s*\\noalign{}", "\\hline")
  latex = latex:gsub("\\midrule", "\\hline")

  -- 4. Remove bottomrule inside endlastfoot
  latex = latex:gsub("\\bottomrule%s*\\noalign{}", "")
  latex = latex:gsub("\\bottomrule", "")

  -- 5. Add \hline after every row ending in \\
  local lines = {}
  for line in latex:gmatch("([^\r\n]+)") do
    table.insert(lines, line)
    local trimmed = line:match("^%s*(.-)%s*$")
    if trimmed:sub(-2) == "\\\\" 
       and not trimmed:find("endhead")
       and not trimmed:find("endlastfoot")
       and not trimmed:find("endfirsthead")
       and not trimmed:find("rowcolor")
       and not trimmed:find("caption") then
      table.insert(lines, "\\hline")
    end
  end

  local result = table.concat(lines, "\n")
  result = result:gsub("\\hline%s*\\hline", "\\hline")

  return pandoc.RawBlock("latex", result)
end
