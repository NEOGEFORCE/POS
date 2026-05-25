$excludeFiles = @('app-header.tsx', 'app-sidebar.tsx', 'ScannerOverlay.tsx', 'toast.tsx', 'globals.css')

$files = Get-ChildItem -Path "src" -Recurse -Filter "*.tsx" | Select-String -Pattern "backdrop-blur" | Select-Object -ExpandProperty Path | Sort-Object -Unique | Where-Object { $name = Split-Path $_ -Leaf; $excludeFiles -notcontains $name }

foreach ($f in $files) {
    $content = Get-Content $f -Raw
    $original = $content

    # Remove backdrop-blur variants (most specific first)
    $content = $content -replace '\s+backdrop-blur-xl', ''
    $content = $content -replace '\s+backdrop-blur-lg', ''
    $content = $content -replace '\s+backdrop-blur-md', ''
    $content = $content -replace '\s+backdrop-blur-sm', ''
    $content = $content -replace '\s+backdrop-blur(?!-)', ''
    $content = $content -replace 'backdrop-blur-xl\s*', ''
    $content = $content -replace 'backdrop-blur-lg\s*', ''
    $content = $content -replace 'backdrop-blur-md\s*', ''
    $content = $content -replace 'backdrop-blur-sm\s*', ''
    $content = $content -replace 'backdrop-blur(?!-)\s*', ''

    # Replace bg-black/XX patterns
    $content = $content -replace 'bg-black/[89]\d', 'bg-zinc-950'
    $content = $content -replace 'bg-black/80', 'bg-zinc-950'
    $content = $content -replace 'bg-black/[2-7]\d', 'bg-zinc-900'
    $content = $content -replace 'bg-black/20', 'bg-zinc-900'

    # Replace bg-white/XX patterns
    $content = $content -replace 'bg-white/\d+', 'bg-white dark:bg-zinc-900'

    # Clean up double spaces in class strings
    $content = $content -replace '  +', ' '

    if ($content -ne $original) {
        Set-Content -Path $f -Value $content -NoNewline
        Write-Output "MODIFIED: $f"
    } else {
        Write-Output "UNCHANGED: $f"
    }
}
Write-Output "DONE"
