# =============================================================================
#  Genera el DICCIONARIO DE DATOS - MODULO INVENTARIO (POS Surtifamiliar)
#  Salida: DICCIONARIO_DATOS_INVENTARIO.docx en la misma carpeta del script
#  Requiere: Microsoft Word instalado (usa COM Automation).
# =============================================================================

$ErrorActionPreference = 'Stop'
$OutputPath = Join-Path $PSScriptRoot 'DICCIONARIO_DATOS_INVENTARIO.docx'
if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force }

Write-Host "Iniciando Microsoft Word..." -ForegroundColor Cyan
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0  # wdAlertsNone

try {

$doc = $word.Documents.Add()
$sel = $word.Selection

# ---------- Configuracion de pagina ----------
$doc.PageSetup.TopMargin    = $word.CentimetersToPoints(2.2)
$doc.PageSetup.BottomMargin = $word.CentimetersToPoints(2.2)
$doc.PageSetup.LeftMargin   = $word.CentimetersToPoints(2.2)
$doc.PageSetup.RightMargin  = $word.CentimetersToPoints(2.2)

# ---------- Estilos por ID (independientes del idioma) ----------
# Ver: WdBuiltinStyle enum de Word COM
$wdStyleNormal    = -1
$wdStyleHeading1  = -2
$wdStyleHeading2  = -3
$wdStyleHeading3  = -4
$wdStyleTitle     = -63

function Set-BuiltinStyle {
    param([int]$StyleId)
    try { $sel.set_Style($doc.Styles.Item($StyleId)) } catch { }
}

# ---------- Helpers ----------
function Add-Paragraph {
    param(
        [string]$Text,
        [int]$Size = 11,
        [bool]$Bold = $false,
        [int]$Alignment = 0,   # 0=Left, 1=Center, 3=Justify
        [int]$Color = 0x1F2937,
        [int]$SpaceAfter = 6
    )
    Set-BuiltinStyle $wdStyleNormal
    $sel.Font.Name = 'Calibri'
    $sel.Font.Size = $Size
    $sel.Font.Bold = $Bold
    $sel.Font.Color = $Color
    $sel.ParagraphFormat.Alignment    = $Alignment
    $sel.ParagraphFormat.SpaceAfter   = $SpaceAfter
    $sel.ParagraphFormat.SpaceBefore  = 0
    $sel.ParagraphFormat.LineSpacingRule = 0  # single
    $sel.TypeText($Text)
    $sel.TypeParagraph()
}

function Add-Title {
    param([string]$Text)
    Set-BuiltinStyle $wdStyleTitle
    $sel.Font.Name = 'Calibri'
    $sel.Font.Size = 26
    $sel.Font.Bold = $true
    $sel.Font.Color = 0x9D2A0F   # #0F2A9D (BGR)
    $sel.ParagraphFormat.Alignment = 1
    $sel.TypeText($Text)
    $sel.TypeParagraph()
}

function Add-H1 {
    param([string]$Text)
    Set-BuiltinStyle $wdStyleHeading1
    $sel.Font.Name = 'Calibri'
    $sel.Font.Size = 18
    $sel.Font.Bold = $true
    $sel.Font.Color = 0x8B1A0F  # #0F1A8B (BGR)
    $sel.ParagraphFormat.Alignment = 0
    $sel.ParagraphFormat.SpaceBefore = 14
    $sel.ParagraphFormat.SpaceAfter  = 8
    $sel.TypeText($Text)
    $sel.TypeParagraph()
}

function Add-H2 {
    param([string]$Text)
    Set-BuiltinStyle $wdStyleHeading2
    $sel.Font.Name = 'Calibri'
    $sel.Font.Size = 14
    $sel.Font.Bold = $true
    $sel.Font.Color = 0x513337  # #374151 (BGR)
    $sel.ParagraphFormat.Alignment = 0
    $sel.ParagraphFormat.SpaceBefore = 10
    $sel.ParagraphFormat.SpaceAfter  = 4
    $sel.TypeText($Text)
    $sel.TypeParagraph()
}

function Add-H3 {
    param([string]$Text)
    Set-BuiltinStyle $wdStyleHeading3
    $sel.Font.Name = 'Calibri'
    $sel.Font.Size = 12
    $sel.Font.Bold = $true
    $sel.Font.Color = 0x63554B  # #4B5563 (BGR)
    $sel.ParagraphFormat.Alignment = 0
    $sel.ParagraphFormat.SpaceBefore = 8
    $sel.ParagraphFormat.SpaceAfter  = 3
    $sel.TypeText($Text)
    $sel.TypeParagraph()
}

function Add-Text {
    param([string]$Text, [bool]$Bold=$false, [int]$Size=11, [int]$SpaceAfter=6, [int]$Alignment=3)
    Set-BuiltinStyle $wdStyleNormal
    $sel.Font.Name = 'Calibri'
    $sel.Font.Size = $Size
    $sel.Font.Bold = $Bold
    $sel.Font.Color = 0x1F2937
    $sel.ParagraphFormat.Alignment = $Alignment
    $sel.ParagraphFormat.SpaceAfter = $SpaceAfter
    $sel.ParagraphFormat.SpaceBefore = 0
    $sel.ParagraphFormat.LineSpacingRule = 0
    $sel.TypeText($Text)
    $sel.TypeParagraph()
}

function Add-Bullet {
    param([string]$Text)
    Set-BuiltinStyle $wdStyleNormal
    $sel.Font.Name = 'Calibri'
    $sel.Font.Size = 11
    $sel.Font.Bold = $false
    $sel.Font.Color = 0x1F2937
    $sel.ParagraphFormat.Alignment = 0
    $sel.ParagraphFormat.LeftIndent = $word.CentimetersToPoints(0.75)
    $sel.ParagraphFormat.SpaceAfter = 2
    $sel.TypeText([char]0x2022 + "  " + $Text)
    $sel.TypeParagraph()
    $sel.ParagraphFormat.LeftIndent = 0
}

# Construye una tabla de campos.
# $fields es un array de hashes con: Nombre, Tipo, Nulo, Clave, Descripcion
function Add-FieldsTable {
    param(
        [Parameter(Mandatory=$true)]$Fields
    )
    $rows = $Fields.Count + 1
    $cols = 5
    $range = $sel.Range
    $tbl = $doc.Tables.Add($range, $rows, $cols)
    $tbl.Borders.Enable = $true
    $tbl.Range.Font.Name = 'Calibri'
    $tbl.Range.Font.Size = 10
    $tbl.Range.ParagraphFormat.SpaceAfter = 0
    $tbl.Range.ParagraphFormat.SpaceBefore = 0
    $tbl.AllowAutoFit = $false
    $tbl.PreferredWidthType = 2   # wdPreferredWidthPercent
    $tbl.PreferredWidth = 100

    # ancho de columnas
    $tbl.Columns.Item(1).PreferredWidthType = 2; $tbl.Columns.Item(1).PreferredWidth = 20
    $tbl.Columns.Item(2).PreferredWidthType = 2; $tbl.Columns.Item(2).PreferredWidth = 18
    $tbl.Columns.Item(3).PreferredWidthType = 2; $tbl.Columns.Item(3).PreferredWidth = 8
    $tbl.Columns.Item(4).PreferredWidthType = 2; $tbl.Columns.Item(4).PreferredWidth = 10
    $tbl.Columns.Item(5).PreferredWidthType = 2; $tbl.Columns.Item(5).PreferredWidth = 44

    # cabecera
    $hdr = $tbl.Rows.Item(1)
    $hdr.Range.Font.Bold = $true
    $hdr.Range.Font.Color = 0xFFFFFF
    $hdr.Range.Shading.BackgroundPatternColor = 0x8B1A0F  # BGR: #0F1A8B
    $hdr.Range.ParagraphFormat.Alignment = 1
    $tbl.Cell(1,1).Range.Text = "Campo"
    $tbl.Cell(1,2).Range.Text = "Tipo (BD)"
    $tbl.Cell(1,3).Range.Text = "Nulo"
    $tbl.Cell(1,4).Range.Text = "Clave"
    $tbl.Cell(1,5).Range.Text = "Descripcion"

    for ($i = 0; $i -lt $Fields.Count; $i++) {
        $r = $i + 2
        $f = $Fields[$i]
        $tbl.Cell($r,1).Range.Text = [string]$f.Nombre
        $tbl.Cell($r,2).Range.Text = [string]$f.Tipo
        $tbl.Cell($r,3).Range.Text = [string]$f.Nulo
        $tbl.Cell($r,4).Range.Text = [string]$f.Clave
        $tbl.Cell($r,5).Range.Text = [string]$f.Descripcion
        # alternado
        if ($i % 2 -eq 1) {
            $tbl.Rows.Item($r).Range.Shading.BackgroundPatternColor = 0xFAFAFA
        }
        # primera columna en negrita
        $tbl.Cell($r,1).Range.Font.Bold = $true
    }

    # movernos al final de la tabla y dar espacio
    $sel.EndKey(6) | Out-Null   # wdStory
    $sel.TypeParagraph()
}

# Tabla generica clave-valor para meta-info de una tabla
function Add-MetaTable {
    param([Parameter(Mandatory=$true)][hashtable]$Meta)
    $rows = $Meta.Count
    $cols = 2
    $range = $sel.Range
    $tbl = $doc.Tables.Add($range, $rows, $cols)
    $tbl.Borders.Enable = $true
    $tbl.Range.Font.Name = 'Calibri'
    $tbl.Range.Font.Size = 10
    $tbl.PreferredWidthType = 2
    $tbl.PreferredWidth = 100
    $tbl.Columns.Item(1).PreferredWidthType = 2; $tbl.Columns.Item(1).PreferredWidth = 22
    $tbl.Columns.Item(2).PreferredWidthType = 2; $tbl.Columns.Item(2).PreferredWidth = 78

    $i = 1
    foreach ($k in $Meta.Keys) {
        $tbl.Cell($i,1).Range.Text = [string]$k
        $tbl.Cell($i,1).Range.Font.Bold = $true
        $tbl.Cell($i,1).Range.Shading.BackgroundPatternColor = 0xF3F4F6
        $tbl.Cell($i,2).Range.Text = [string]$Meta[$k]
        $i++
    }
    $sel.EndKey(6) | Out-Null
    $sel.TypeParagraph()
}

# ============================================================================
#  PORTADA
# ============================================================================
$sel.ParagraphFormat.SpaceBefore = 0
$sel.ParagraphFormat.SpaceAfter  = 6
$sel.TypeParagraph(); $sel.TypeParagraph(); $sel.TypeParagraph()

Add-Title -Text "Diccionario de Datos"
Add-Paragraph -Text "Modulo de Inventario" -Size 18 -Bold $true -Alignment 1 -Color 0x513337 -SpaceAfter 4
Add-Paragraph -Text "Sistema POS - Supermercado Surtifamiliar" -Size 14 -Alignment 1 -Color 0x807B6B -SpaceAfter 24

# tabla de portada
$portadaMeta = [ordered]@{
    'Sistema'          = 'POS Surtifamiliar'
    'Modulo'           = 'Inventario, catalogo de productos, proveedores y movimientos'
    'Motor de BD'      = 'PostgreSQL 15+'
    'Backend'          = 'Go 1.25 + GORM v2 (arquitectura hexagonal)'
    'Frontend'         = 'Next.js 15 (App Router) + TypeScript + Tailwind + HeroUI'
    'Zona horaria'     = 'America/Bogota (UTC-5)'
    'Moneda'           = 'Peso colombiano (COP)'
    'Version doc.'     = '1.0'
    'Fecha'            = (Get-Date -Format 'dd/MM/yyyy')
    'Autor'            = 'Equipo POS Surtifamiliar'
}
Add-MetaTable -Meta $portadaMeta

$sel.InsertBreak(7)   # wdPageBreak

# ============================================================================
#  INTRODUCCION
# ============================================================================
Add-H1 -Text "1. Introduccion"
Add-Text -Text ("Este documento describe la estructura de datos que soporta el modulo de " +
    "Inventario del sistema POS del Supermercado Surtifamiliar. Cubre el catalogo de productos, " +
    "las categorias, los proveedores y sus metodos de abastecimiento, el kardex de movimientos de stock, " +
    "las ordenes de compra, los pedidos esperados (preventa), las devoluciones, las mermas, " +
    "la bitacora de precios, los productos faltantes reportados por el personal y las metricas de " +
    "reposicion inteligente calculadas por el cron nocturno.")

Add-Text -Text ("La informacion aqui documentada corresponde uno a uno con los modelos GORM " +
    "definidos en el paquete internal/core/domain/models del backend Go. Los nombres de columnas " +
    "y de tablas coinciden con los declarados en las etiquetas gorm de cada campo.")

Add-H2 -Text "1.1 Convenciones"
Add-Bullet -Text "Los nombres de tabla se muestran en snake_case (nombre fisico en PostgreSQL)."
Add-Bullet -Text "Los nombres de columna respetan el estilo definido por GORM (mezcla camelCase heredado del legado y snake_case en tablas nuevas)."
Add-Bullet -Text "PK = clave primaria, FK = clave foranea, UK = clave unica, IDX = indice."
Add-Bullet -Text "Los campos con tipo DECIMAL(10,2) representan pesos colombianos (COP) sin decimales operativos, pero el motor guarda dos posiciones para redondeos."
Add-Bullet -Text "Los campos DECIMAL(10,3) se usan para pesos y cantidades de productos vendidos por kilo (pesados)."
Add-Bullet -Text "Las columnas createdByDni / updatedByDni referencian employees.DNI (relacion con empleados)."
Add-Bullet -Text "El borrado logico se implementa con la columna deletedAt (GORM soft delete)."

Add-H2 -Text "1.2 Tablas incluidas"
Add-Bullet -Text "products - Catalogo maestro de productos"
Add-Bullet -Text "product_suppliers - Relacion N:M productos <-> proveedores"
Add-Bullet -Text "price_logs - Bitacora de cambios de precio"
Add-Bullet -Text "categories - Categorias / familias de productos"
Add-Bullet -Text "suppliers - Proveedores (empresas)"
Add-Bullet -Text "supplier_order_methods - Metodos de pedido (ruta o app)"
Add-Bullet -Text "stock_movements - Kardex: entradas y salidas de stock"
Add-Bullet -Text "purchase_orders - Ordenes de compra legado"
Add-Bullet -Text "purchase_order_items - Items de la orden de compra"
Add-Bullet -Text "expected_orders / expected_order_items - Pedidos esperados (preventa)"
Add-Bullet -Text "active_purchase_list - Lista activa de compras del comprador"
Add-Bullet -Text "confirmed_orders / confirmed_order_items - Ordenes confirmadas al proveedor"
Add-Bullet -Text "returns / return_details - Devoluciones de clientes"
Add-Bullet -Text "shrinkages - Mermas (rotura, vencimiento, hurto, consumo interno)"
Add-Bullet -Text "missing_items - Productos que se reportan como agotados"
Add-Bullet -Text "daily_stock_snapshots - Fotos diarias de stock por producto"
Add-Bullet -Text "product_restock_metrics - Metricas del cron nocturno de reposicion"

$sel.InsertBreak(7)

# ============================================================================
#  2. products
# ============================================================================
Add-H1 -Text "2. Tabla: products"
Add-Text -Text ("Catalogo maestro del inventario. Cada fila es un producto identificado por su codigo " +
    "de barras. Guarda las cantidades disponibles, el precio de costo (compra), el precio de venta al publico (PVP), " +
    "el margen contable, la categoria a la que pertenece, el proveedor principal, las banderas de estado " +
    "(activo / pesado / empaque) y la relacion con empaques (packs).")

Add-H3 -Text "Estructura"
Add-FieldsTable -Fields @(
    @{ Nombre='barcode';          Tipo='VARCHAR (PK)';   Nulo='NO'; Clave='PK';    Descripcion='Codigo de barras EAN/UPC. Identificador unico del producto.' },
    @{ Nombre='productName';      Tipo='VARCHAR';        Nulo='NO'; Clave='';      Descripcion='Nombre visible del producto. Usado en el ticket y en la busqueda.' },
    @{ Nombre='quantity';         Tipo='DOUBLE';         Nulo='NO'; Clave='';      Descripcion='Cantidad disponible en tienda. Se actualiza en tiempo real por ventas, recepciones, devoluciones y mermas. Puede ser negativa (decision del dueno).' },
    @{ Nombre='isWeighted';       Tipo='BOOLEAN';        Nulo='NO'; Clave='';      Descripcion='true si el producto se vende por kilo (usa balanza). Afecta la logica de venta y el redondeo.' },
    @{ Nombre='purchasePrice';    Tipo='DECIMAL(10,2)';  Nulo='NO'; Clave='';      Descripcion='Precio de compra neto (COP) sin descuento del proveedor.' },
    @{ Nombre='iva';              Tipo='DECIMAL(10,2)';  Nulo='SI'; Clave='';      Descripcion='Porcentaje de IVA aplicable (0, 5, 19).' },
    @{ Nombre='icui';             Tipo='DECIMAL(10,2)';  Nulo='SI'; Clave='';      Descripcion='Impuesto al consumo (aplica a algunos productos).' },
    @{ Nombre='ibua';             Tipo='DECIMAL(10,2)';  Nulo='SI'; Clave='';      Descripcion='Impuesto saludable a bebidas azucaradas (ley 2277 de 2022).' },
    @{ Nombre='discount';         Tipo='DECIMAL(10,2)';  Nulo='SI'; Clave='';      Descripcion='Descuento porcentual del proveedor. NO se resta al costo (regla del negocio); se suma al margen del PVP.' },
    @{ Nombre='marginPercentage'; Tipo='DECIMAL(10,4)';  Nulo='SI'; Clave='';      Descripcion='Porcentaje de ganancia base configurado para el producto.' },
    @{ Nombre='salePrice';        Tipo='DECIMAL(10,2)';  Nulo='NO'; Clave='';      Descripcion='Precio de venta al publico (PVP) en COP.' },
    @{ Nombre='categoryId';       Tipo='INTEGER';        Nulo='SI'; Clave='FK,IDX';Descripcion='FK a categories.id. ON DELETE SET NULL: si se borra la categoria, el producto queda sin categoria.' },
    @{ Nombre='supplierId';       Tipo='INTEGER';        Nulo='SI'; Clave='FK,IDX';Descripcion='FK a suppliers.id. Proveedor principal del producto. ON DELETE SET NULL.' },
    @{ Nombre='createdByDni';     Tipo='VARCHAR';        Nulo='SI'; Clave='FK,IDX';Descripcion='DNI del empleado que dio de alta el producto (referencia a employees.DNI).' },
    @{ Nombre='createdByName';    Tipo='VARCHAR';        Nulo='SI'; Clave='';      Descripcion='Nombre denormalizado del creador (evita join).' },
    @{ Nombre='updatedByDni';     Tipo='VARCHAR';        Nulo='SI'; Clave='FK,IDX';Descripcion='DNI del empleado que hizo la ultima modificacion.' },
    @{ Nombre='updatedByName';    Tipo='VARCHAR';        Nulo='SI'; Clave='';      Descripcion='Nombre denormalizado del ultimo modificador.' },
    @{ Nombre='imageUrl';         Tipo='TEXT';           Nulo='SI'; Clave='';      Descripcion='URL de la imagen del producto (Cloudinary o similar).' },
    @{ Nombre='minStock';         Tipo='DECIMAL(10,2)';  Nulo='SI'; Clave='';      Descripcion='Stock minimo para disparar alerta de reposicion.' },
    @{ Nombre='min_shelf_stock';  Tipo='DECIMAL(10,2)';  Nulo='SI'; Clave='';      Descripcion='Stock minimo que debe estar visible en la gondola.' },
    @{ Nombre='isActive';         Tipo='BOOLEAN';        Nulo='NO'; Clave='';      Descripcion='true = activo en el POS. false = descontinuado (no aparece en busqueda de venta).' },
    @{ Nombre='alternate_codes';  Tipo='TEXT';           Nulo='SI'; Clave='';      Descripcion='Otros codigos de barras que apuntan al mismo producto (separados por coma).' },
    @{ Nombre='isPack';           Tipo='BOOLEAN';        Nulo='NO'; Clave='';      Descripcion='true si el producto es un empaque compuesto (caja/pack) de otro producto base.' },
    @{ Nombre='baseProductBarcode';Tipo='VARCHAR';       Nulo='SI'; Clave='FK,IDX';Descripcion='Solo si isPack=true. FK a products.barcode del producto unitario contenido en el pack.' },
    @{ Nombre='packMultiplier';   Tipo='INTEGER';        Nulo='SI'; Clave='';      Descripcion='Cuantas unidades base contiene el pack (ej: caja de 12).' },
    @{ Nombre='order_multiple';   Tipo='INTEGER';        Nulo='SI'; Clave='';      Descripcion='Multiplo de pedido al proveedor (paquete o bulto).' },
    @{ Nombre='updatedAt';        Tipo='TIMESTAMP';      Nulo='NO'; Clave='';      Descripcion='Fecha de ultima actualizacion (autoUpdateTime de GORM).' },
    @{ Nombre='deletedAt';        Tipo='TIMESTAMP';      Nulo='SI'; Clave='IDX';   Descripcion='Fecha de soft delete. NULL = registro vigente.' }
)

Add-H3 -Text "Relaciones"
Add-Bullet -Text "N:1 con categories via categoryId."
Add-Bullet -Text "N:1 con suppliers via supplierId (proveedor principal)."
Add-Bullet -Text "N:M con suppliers via product_suppliers (todos los proveedores que lo venden)."
Add-Bullet -Text "1:N con stock_movements (kardex)."
Add-Bullet -Text "1:N con price_logs (bitacora de precios)."
Add-Bullet -Text "1:N con sale_details, return_details, shrinkages, purchase_order_items."
Add-Bullet -Text "Auto-referencia con baseProductBarcode (pack -> producto base)."

Add-H3 -Text "Reglas de negocio"
Add-Bullet -Text "El barcode es inmutable una vez creado. Cambiarlo requiere migrar todas las relaciones."
Add-Bullet -Text "La cantidad puede ser negativa: el sistema NO bloquea ventas por stock 0."
Add-Bullet -Text "En recepcion, el costo neto y el PVP se recalculan segun la regla aditiva: PVP = costo * (1 + margen + descuento_proveedor)."
Add-Bullet -Text "isActive=false esconde el producto de la busqueda de venta pero conserva su historia."

$sel.InsertBreak(7)

# ============================================================================
#  3. product_suppliers
# ============================================================================
Add-H1 -Text "3. Tabla: product_suppliers"
Add-Text -Text ("Tabla de relacion muchos-a-muchos entre productos y proveedores. Guarda el precio " +
    "de compra especifico de cada proveedor para cada producto, lo que permite comparar precios y " +
    "detectar proveedores mas baratos (feature de smart restock).")

Add-FieldsTable -Fields @(
    @{ Nombre='product_barcode'; Tipo='VARCHAR (PK)';  Nulo='NO'; Clave='PK,FK';   Descripcion='FK a products.barcode. Parte de la clave compuesta.' },
    @{ Nombre='supplier_id';     Tipo='INTEGER (PK)';  Nulo='NO'; Clave='PK,FK';   Descripcion='FK a suppliers.id. Parte de la clave compuesta.' },
    @{ Nombre='purchasePrice';   Tipo='DECIMAL(10,2)'; Nulo='SI'; Clave='';        Descripcion='Precio al que este proveedor vende este producto.' },
    @{ Nombre='created_at';      Tipo='BIGINT';        Nulo='NO'; Clave='';        Descripcion='Timestamp UNIX de creacion (autoCreateTime).' },
    @{ Nombre='updated_at';      Tipo='BIGINT';        Nulo='NO'; Clave='';        Descripcion='Timestamp UNIX de ultima actualizacion.' }
)

# ============================================================================
#  4. price_logs
# ============================================================================
Add-H1 -Text "4. Tabla: price_logs"
Add-Text -Text ("Bitacora inmutable de cambios de precio. Cada modificacion del PVP o del costo " +
    "de un producto deja un rastro auditable con el precio anterior, el nuevo y la fecha.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';              Tipo='SERIAL (PK)';    Nulo='NO'; Clave='PK';    Descripcion='Identificador autoincremental.' },
    @{ Nombre='product_barcode'; Tipo='VARCHAR';        Nulo='NO'; Clave='FK,IDX';Descripcion='FK a products.barcode.' },
    @{ Nombre='product_name';    Tipo='VARCHAR';        Nulo='SI'; Clave='';      Descripcion='Nombre del producto en el momento del cambio (denormalizado para reportes historicos).' },
    @{ Nombre='old_price';       Tipo='DECIMAL(10,2)';  Nulo='NO'; Clave='';      Descripcion='Precio anterior (COP).' },
    @{ Nombre='new_price';       Tipo='DECIMAL(10,2)';  Nulo='NO'; Clave='';      Descripcion='Precio nuevo (COP).' },
    @{ Nombre='created_at';      Tipo='BIGINT';         Nulo='NO'; Clave='';      Descripcion='Timestamp UNIX del cambio.' }
)

# ============================================================================
#  5. categories
# ============================================================================
Add-H1 -Text "5. Tabla: categories"
Add-Text -Text ("Categorias del catalogo (ej: LACTEOS, ASEO, GRANOS, BEBIDAS). Se usa para agrupar " +
    "productos en el POS, aplicar margenes por familia y filtrar reportes de rentabilidad.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';                Tipo='SERIAL (PK)';    Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='name';              Tipo='VARCHAR';        Nulo='NO'; Clave='';       Descripcion='Nombre de la categoria.' },
    @{ Nombre='createdByDni';      Tipo='VARCHAR';        Nulo='SI'; Clave='FK,IDX'; Descripcion='DNI del empleado creador (referencia a employees.DNI).' },
    @{ Nombre='createdByName';     Tipo='VARCHAR';        Nulo='SI'; Clave='';       Descripcion='Nombre denormalizado del creador.' },
    @{ Nombre='updatedByDni';      Tipo='VARCHAR';        Nulo='SI'; Clave='FK,IDX'; Descripcion='DNI del ultimo modificador.' },
    @{ Nombre='updatedByName';     Tipo='VARCHAR';        Nulo='SI'; Clave='';       Descripcion='Nombre denormalizado del ultimo modificador.' },
    @{ Nombre='product_count';     Tipo='INTEGER (calc)'; Nulo='SI'; Clave='';       Descripcion='Cantidad de productos en la categoria. Calculado en runtime, no persistido.' },
    @{ Nombre='margin_percentage'; Tipo='DECIMAL(5,2)';   Nulo='SI'; Clave='';       Descripcion='Margen sugerido por defecto para productos de esta categoria.' },
    @{ Nombre='is_active';         Tipo='BOOLEAN';        Nulo='NO'; Clave='';       Descripcion='true = categoria visible en el POS.' },
    @{ Nombre='deletedAt';         Tipo='TIMESTAMP';      Nulo='SI'; Clave='IDX';    Descripcion='Fecha de soft delete.' }
)

$sel.InsertBreak(7)

# ============================================================================
#  6. suppliers
# ============================================================================
Add-H1 -Text "6. Tabla: suppliers"
Add-Text -Text ("Proveedores del supermercado. Guarda datos de contacto, dias de visita del preventista, " +
    "dias de entrega del despachador, y el metodo de abastecimiento (ruta o app).")

Add-FieldsTable -Fields @(
    @{ Nombre='id';                    Tipo='SERIAL (PK)'; Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='name';                  Tipo='VARCHAR';     Nulo='NO'; Clave='';       Descripcion='Razon social o nombre comercial del proveedor.' },
    @{ Nombre='phone';                 Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='Telefono de contacto.' },
    @{ Nombre='vendorName';            Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='Nombre del vendedor / preventista asignado.' },
    @{ Nombre='createdByDni';          Tipo='VARCHAR';     Nulo='SI'; Clave='FK,IDX'; Descripcion='DNI del empleado creador.' },
    @{ Nombre='createdByName';         Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='Nombre denormalizado del creador.' },
    @{ Nombre='updatedByDni';          Tipo='VARCHAR';     Nulo='SI'; Clave='FK,IDX'; Descripcion='DNI del ultimo modificador.' },
    @{ Nombre='updatedByName';         Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='Nombre denormalizado del ultimo modificador.' },
    @{ Nombre='imageUrl';              Tipo='TEXT';        Nulo='SI'; Clave='';       Descripcion='URL del logo del proveedor.' },
    @{ Nombre='visitDay';              Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='LEGACY: dia unico de visita (mantiene compatibilidad).' },
    @{ Nombre='deliveryDay';           Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='LEGACY: dia unico de entrega (mantiene compatibilidad).' },
    @{ Nombre='visit_days';            Tipo='JSONB';       Nulo='SI'; Clave='';       Descripcion='Array de dias de visita (ej: ["LUN","JUE"]).' },
    @{ Nombre='delivery_days';         Tipo='JSONB';       Nulo='SI'; Clave='';       Descripcion='Array de dias de entrega.' },
    @{ Nombre='restock_method';        Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='Metodo principal de abastecimiento (ROUTE, APP, MIXED).' },
    @{ Nombre='visit_frequency_days';  Tipo='INTEGER';     Nulo='SI'; Clave='';       Descripcion='Frecuencia estandar entre visitas en dias (default 7).' },
    @{ Nombre='is_active';             Tipo='BOOLEAN';     Nulo='NO'; Clave='';       Descripcion='true = proveedor activo.' },
    @{ Nombre='deletedAt';             Tipo='TIMESTAMP';   Nulo='SI'; Clave='IDX';    Descripcion='Fecha de soft delete.' }
)

# ============================================================================
#  7. supplier_order_methods
# ============================================================================
Add-H1 -Text "7. Tabla: supplier_order_methods"
Add-Text -Text ("Metodos de pedido de un proveedor. Un mismo proveedor puede tener varios canales, " +
    "por ejemplo una ruta fisica (visita del preventista) y una app (Pideky, Surtiapp). El sistema " +
    "usa esta tabla para calcular en cuantos dias llegara un pedido (lead time) y para sugerir el mejor canal.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';           Tipo='SERIAL (PK)'; Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='supplierId';   Tipo='INTEGER';     Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a suppliers.id.' },
    @{ Nombre='type';         Tipo='VARCHAR';     Nulo='NO'; Clave='';       Descripcion='ROUTE = visita fisica del preventista. APP = pedido por aplicacion.' },
    @{ Nombre='platformName'; Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='Nombre de la plataforma (ej: Pideky, Surtiapp, Preventista).' },
    @{ Nombre='visitDays';    Tipo='JSONB';       Nulo='SI'; Clave='';       Descripcion='Solo para ROUTE. Array de dias de la semana en formato numero (1=Lunes ... 7=Domingo).' },
    @{ Nombre='leadTimeDays'; Tipo='INTEGER';     Nulo='NO'; Clave='';       Descripcion='Dias entre pedido y entrega. Default 1.' },
    @{ Nombre='isActive';     Tipo='BOOLEAN';     Nulo='NO'; Clave='';       Descripcion='true = metodo habilitado.' },
    @{ Nombre='createdAt';    Tipo='BIGINT';      Nulo='NO'; Clave='';       Descripcion='Timestamp UNIX de creacion.' },
    @{ Nombre='updatedAt';    Tipo='BIGINT';      Nulo='NO'; Clave='';       Descripcion='Timestamp UNIX de ultima actualizacion.' },
    @{ Nombre='deletedAt';    Tipo='TIMESTAMP';   Nulo='SI'; Clave='IDX';    Descripcion='Fecha de soft delete.' }
)

$sel.InsertBreak(7)

# ============================================================================
#  8. stock_movements  (kardex)
# ============================================================================
Add-H1 -Text "8. Tabla: stock_movements"
Add-Text -Text ("KARDEX de inventario. Cada entrada o salida de stock (venta, recepcion, devolucion, " +
    "ajuste manual, merma, borrado) genera una fila. Es la fuente de verdad para reconstruir el " +
    "inventario en cualquier fecha pasada y auditar movimientos.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';              Tipo='SERIAL (PK)'; Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='date';            Tipo='TIMESTAMP';   Nulo='NO'; Clave='IDX';    Descripcion='Fecha y hora del movimiento (default now()).' },
    @{ Nombre='barcode';         Tipo='VARCHAR';     Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a products.barcode.' },
    @{ Nombre='quantity';        Tipo='DOUBLE';      Nulo='NO'; Clave='';       Descripcion='Cantidad movida (siempre positiva; el signo se infiere de type).' },
    @{ Nombre='type';            Tipo='VARCHAR';     Nulo='NO'; Clave='IDX';    Descripcion='IN o OUT.' },
    @{ Nombre='reason';          Tipo='VARCHAR';     Nulo='NO'; Clave='IDX';    Descripcion='SALE, RECEPTION, RETURN, ADJUSTMENT, DELETE, SHRINKAGE.' },
    @{ Nombre='employeeDni';     Tipo='VARCHAR';     Nulo='SI'; Clave='FK,IDX'; Descripcion='DNI del empleado que origino el movimiento.' },
    @{ Nombre='employeeName';    Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='Nombre denormalizado del empleado.' },
    @{ Nombre='referenceId';     Tipo='VARCHAR';     Nulo='SI'; Clave='IDX';    Descripcion='ID de la entidad que origino el movimiento (sale.id, return.id, reception.id).' },
    @{ Nombre='metadata';        Tipo='TEXT (JSON)'; Nulo='SI'; Clave='';       Descripcion='Snapshot en JSON con precios e impuestos al momento del movimiento.' },
    @{ Nombre='edited_by';       Tipo='VARCHAR';     Nulo='SI'; Clave='IDX';    Descripcion='DNI del empleado que edito la fila (si aplica).' },
    @{ Nombre='edited_at';       Tipo='TIMESTAMP';   Nulo='SI'; Clave='';       Descripcion='Fecha de ultima edicion.' },
    @{ Nombre='original_values'; Tipo='JSONB';       Nulo='SI'; Clave='';       Descripcion='Valores originales antes de la edicion (auditoria).' },
    @{ Nombre='annulled_by';     Tipo='VARCHAR';     Nulo='SI'; Clave='IDX';    Descripcion='DNI del empleado que anulo el movimiento.' },
    @{ Nombre='annulled_at';     Tipo='TIMESTAMP';   Nulo='SI'; Clave='';       Descripcion='Fecha de anulacion.' },
    @{ Nombre='annulled_reason'; Tipo='TEXT';        Nulo='SI'; Clave='';       Descripcion='Motivo textual de la anulacion.' }
)

Add-H3 -Text "Restricciones y reglas"
Add-Bullet -Text "Los valores validos de reason son: SALE, RECEPTION, RETURN, ADJUSTMENT, DELETE, SHRINKAGE."
Add-Bullet -Text "type puede ser IN (entrada: recepcion, devolucion, ajuste positivo) o OUT (salida: venta, ajuste negativo, merma)."
Add-Bullet -Text "El campo metadata guarda un snapshot serializado en JSON del producto en el momento del movimiento; se usa para reconstruir precios historicos (valorizacion de inventario)."
Add-Bullet -Text "Este es el UNICO libro contable de inventario: cualquier reporte de existencias historicas debe reconstruirse desde aqui."

$sel.InsertBreak(7)

# ============================================================================
#  9. purchase_orders / 10. purchase_order_items
# ============================================================================
Add-H1 -Text "9. Tabla: purchase_orders"
Add-Text -Text ("Ordenes de compra al proveedor (modulo legado, coexiste con confirmed_orders). " +
    "Cada orden tiene una cabecera con el proveedor, fechas y estado, mas un conjunto de items.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';            Tipo='SERIAL (PK)';    Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='supplierId';    Tipo='INTEGER';        Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a suppliers.id.' },
    @{ Nombre='orderDate';     Tipo='TIMESTAMP';      Nulo='NO'; Clave='';       Descripcion='Fecha en que se emitio el pedido (default now()).' },
    @{ Nombre='deliveryDate';  Tipo='TIMESTAMP';      Nulo='SI'; Clave='';       Descripcion='Fecha estimada / real de entrega.' },
    @{ Nombre='estimatedCost'; Tipo='DECIMAL(10,2)';  Nulo='NO'; Clave='';       Descripcion='Costo estimado total de la orden (COP).' },
    @{ Nombre='status';        Tipo='VARCHAR(20)';    Nulo='NO'; Clave='';       Descripcion='PENDING, RECEIVED o CANCELLED.' },
    @{ Nombre='createdByDni';  Tipo='VARCHAR';        Nulo='SI'; Clave='FK,IDX'; Descripcion='DNI del empleado que creo la orden.' },
    @{ Nombre='deletedAt';     Tipo='TIMESTAMP';      Nulo='SI'; Clave='IDX';    Descripcion='Fecha de soft delete.' }
)

Add-H1 -Text "10. Tabla: purchase_order_items"
Add-Text -Text "Items (renglones) de una orden de compra."

Add-FieldsTable -Fields @(
    @{ Nombre='id';             Tipo='SERIAL (PK)';   Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='orderId';        Tipo='INTEGER';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a purchase_orders.id.' },
    @{ Nombre='productBarcode'; Tipo='VARCHAR';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a products.barcode.' },
    @{ Nombre='quantity';       Tipo='DOUBLE';        Nulo='NO'; Clave='';       Descripcion='Cantidad pedida.' },
    @{ Nombre='unitPrice';      Tipo='DECIMAL(10,2)'; Nulo='NO'; Clave='';       Descripcion='Precio unitario del producto en esta orden.' },
    @{ Nombre='subtotal';       Tipo='DECIMAL(10,2)'; Nulo='NO'; Clave='';       Descripcion='quantity * unitPrice (denormalizado).' },
    @{ Nombre='deletedAt';      Tipo='TIMESTAMP';     Nulo='SI'; Clave='IDX';    Descripcion='Fecha de soft delete.' }
)

$sel.InsertBreak(7)

# ============================================================================
#  11. expected_orders / 12. expected_order_items
# ============================================================================
Add-H1 -Text "11. Tabla: expected_orders"
Add-Text -Text ("Pedidos ESPERADOS (preventa). El proveedor visita el negocio, se toma el pedido y se " +
    "registra como expected_order. La entrega se hace en dias posteriores.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';              Tipo='SERIAL (PK)';   Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='supplierId';      Tipo='INTEGER';       Nulo='SI'; Clave='FK,IDX'; Descripcion='FK a suppliers.id.' },
    @{ Nombre='supplierName';    Tipo='VARCHAR';       Nulo='SI'; Clave='';       Descripcion='Nombre denormalizado del proveedor (evita join).' },
    @{ Nombre='expectedDate';    Tipo='TIMESTAMP';     Nulo='NO'; Clave='';       Descripcion='Fecha en que se espera la entrega.' },
    @{ Nombre='totalEstimated';  Tipo='DECIMAL(10,2)'; Nulo='SI'; Clave='';       Descripcion='Costo total estimado (COP).' },
    @{ Nombre='itemCount';       Tipo='INTEGER';       Nulo='SI'; Clave='';       Descripcion='Cantidad de items distintos en el pedido (denormalizado).' },
    @{ Nombre='status';          Tipo='VARCHAR(20)';   Nulo='NO'; Clave='';       Descripcion='PENDING, RECEIVED, CANCELLED.' },
    @{ Nombre='createdByDni';    Tipo='VARCHAR';       Nulo='SI'; Clave='FK,IDX'; Descripcion='DNI del empleado que registro el pedido.' },
    @{ Nombre='createdByName';   Tipo='VARCHAR';       Nulo='SI'; Clave='';       Descripcion='Nombre denormalizado del creador.' },
    @{ Nombre='createdAt';       Tipo='TIMESTAMP';     Nulo='NO'; Clave='';       Descripcion='Fecha de creacion del registro.' },
    @{ Nombre='updatedAt';       Tipo='TIMESTAMP';     Nulo='NO'; Clave='';       Descripcion='Fecha de ultima actualizacion.' },
    @{ Nombre='deletedAt';       Tipo='TIMESTAMP';     Nulo='SI'; Clave='IDX';    Descripcion='Fecha de soft delete.' }
)

Add-H1 -Text "12. Tabla: expected_order_items"
Add-Text -Text "Items del pedido esperado."

Add-FieldsTable -Fields @(
    @{ Nombre='id';                Tipo='SERIAL (PK)';   Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='expected_order_id'; Tipo='INTEGER';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a expected_orders.id.' },
    @{ Nombre='barcode';           Tipo='VARCHAR';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a products.barcode.' },
    @{ Nombre='product_name';      Tipo='VARCHAR';       Nulo='NO'; Clave='';       Descripcion='Nombre denormalizado del producto.' },
    @{ Nombre='expected_quantity'; Tipo='DECIMAL(10,2)'; Nulo='SI'; Clave='';       Descripcion='Cantidad esperada.' },
    @{ Nombre='created_at';        Tipo='TIMESTAMP';     Nulo='NO'; Clave='';       Descripcion='Fecha de creacion (default now()).' }
)

$sel.InsertBreak(7)

# ============================================================================
#  13. active_purchase_list
# ============================================================================
Add-H1 -Text "13. Tabla: active_purchase_list"
Add-Text -Text ("Lista activa de compras del comprador. El sistema de smart restock v2 va acumulando " +
    "aqui las sugerencias antes de confirmarlas como orden real. Piense en un carrito de compras que " +
    "arma el comprador o un algoritmo con base en las metricas del cron.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';           Tipo='UUID (PK)';     Nulo='NO'; Clave='PK';     Descripcion='UUID generado por gen_random_uuid().' },
    @{ Nombre='product_id';   Tipo='VARCHAR';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a products.barcode.' },
    @{ Nombre='supplier_id';  Tipo='INTEGER';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a suppliers.id.' },
    @{ Nombre='quantity';     Tipo='DOUBLE';        Nulo='NO'; Clave='';       Descripcion='Cantidad tentativa a pedir.' },
    @{ Nombre='status';       Tipo='VARCHAR(20)';   Nulo='NO'; Clave='';       Descripcion='pending, ordered, received.' },
    @{ Nombre='created_at';   Tipo='TIMESTAMP';     Nulo='NO'; Clave='';       Descripcion='Fecha en que entro a la lista.' },
    @{ Nombre='created_by';   Tipo='VARCHAR';       Nulo='SI'; Clave='';       Descripcion='DNI o nombre del creador.' }
)

# ============================================================================
#  14. confirmed_orders / 15. confirmed_order_items
# ============================================================================
Add-H1 -Text "14. Tabla: confirmed_orders"
Add-Text -Text ("Orden confirmada al proveedor. Materializa una active_purchase_list cuando el " +
    "comprador la envia. Guarda referencia de factura, total estimado, total real y estado de recepcion.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';                Tipo='UUID (PK)';     Nulo='NO'; Clave='PK';     Descripcion='UUID generado por gen_random_uuid().' },
    @{ Nombre='supplier_id';       Tipo='INTEGER';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a suppliers.id.' },
    @{ Nombre='estimated_total';   Tipo='DECIMAL(12,2)'; Nulo='SI'; Clave='';       Descripcion='Total estimado al momento de confirmar (COP).' },
    @{ Nombre='real_invoice_total';Tipo='DECIMAL(12,2)'; Nulo='SI'; Clave='';       Descripcion='Total real de la factura del proveedor al recibir.' },
    @{ Nombre='expected_date';     Tipo='DATE';          Nulo='SI'; Clave='';       Descripcion='Fecha esperada de entrega.' },
    @{ Nombre='invoice_ref';       Tipo='VARCHAR(50)';   Nulo='SI'; Clave='';       Descripcion='Numero / referencia de factura.' },
    @{ Nombre='status';            Tipo='VARCHAR(20)';   Nulo='NO'; Clave='';       Descripcion='pending, in_transit, received.' },
    @{ Nombre='confirmed_at';      Tipo='TIMESTAMP';     Nulo='NO'; Clave='';       Descripcion='Fecha en que se confirmo el pedido (default now()).' },
    @{ Nombre='confirmed_by';      Tipo='VARCHAR(255)';  Nulo='SI'; Clave='';       Descripcion='Empleado que confirmo.' },
    @{ Nombre='received_at';       Tipo='TIMESTAMP';     Nulo='SI'; Clave='';       Descripcion='Fecha en que se recibio la mercancia.' },
    @{ Nombre='received_by';       Tipo='VARCHAR(255)';  Nulo='SI'; Clave='';       Descripcion='Empleado que recibio.' }
)

Add-H1 -Text "15. Tabla: confirmed_order_items"
Add-Text -Text "Items de la orden confirmada."

Add-FieldsTable -Fields @(
    @{ Nombre='id';                 Tipo='UUID (PK)';     Nulo='NO'; Clave='PK';     Descripcion='UUID generado por gen_random_uuid().' },
    @{ Nombre='confirmed_order_id'; Tipo='UUID';          Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a confirmed_orders.id. ON DELETE CASCADE.' },
    @{ Nombre='product_id';         Tipo='VARCHAR';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a products.barcode.' },
    @{ Nombre='quantity';           Tipo='DOUBLE';        Nulo='NO'; Clave='';       Descripcion='Cantidad pedida.' },
    @{ Nombre='estimated_price';    Tipo='DECIMAL(10,2)'; Nulo='SI'; Clave='';       Descripcion='Precio unitario estimado al confirmar.' }
)

$sel.InsertBreak(7)

# ============================================================================
#  16. returns / 17. return_details
# ============================================================================
Add-H1 -Text "16. Tabla: returns"
Add-Text -Text ("Devoluciones de clientes. Cada devolucion referencia la venta original y guarda el " +
    "total devuelto, motivo, tipo (reembolso o cambio) y el empleado que la proceso.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';             Tipo='SERIAL (PK)';   Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='saleId';         Tipo='INTEGER';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a sales.id (venta original).' },
    @{ Nombre='date';           Tipo='TIMESTAMP';     Nulo='NO'; Clave='';       Descripcion='Fecha y hora de la devolucion.' },
    @{ Nombre='totalReturned';  Tipo='DECIMAL(10,2)'; Nulo='NO'; Clave='';       Descripcion='Total devuelto (COP).' },
    @{ Nombre='reason';         Tipo='VARCHAR';       Nulo='SI'; Clave='';       Descripcion='Motivo textual.' },
    @{ Nombre='returnType';     Tipo='VARCHAR';       Nulo='SI'; Clave='';       Descripcion='REFUND (reembolso) o EXCHANGE (cambio por otro producto).' },
    @{ Nombre='employeeDni';    Tipo='VARCHAR';       Nulo='NO'; Clave='FK,IDX'; Descripcion='DNI del cajero que registro la devolucion.' },
    @{ Nombre='deletedAt';      Tipo='TIMESTAMP';     Nulo='SI'; Clave='IDX';    Descripcion='Fecha de soft delete.' }
)

Add-H1 -Text "17. Tabla: return_details"
Add-Text -Text "Detalle (renglones) de una devolucion."

Add-FieldsTable -Fields @(
    @{ Nombre='id';         Tipo='SERIAL (PK)';   Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='returnId';   Tipo='INTEGER';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a returns.id.' },
    @{ Nombre='barcode';    Tipo='VARCHAR';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a products.barcode.' },
    @{ Nombre='quantity';   Tipo='DOUBLE';        Nulo='NO'; Clave='';       Descripcion='Cantidad devuelta.' },
    @{ Nombre='price';      Tipo='DECIMAL(10,2)'; Nulo='NO'; Clave='';       Descripcion='Precio unitario en el momento de la venta original.' },
    @{ Nombre='subtotal';   Tipo='DECIMAL(10,2)'; Nulo='NO'; Clave='';       Descripcion='quantity * price (denormalizado).' },
    @{ Nombre='isExchange'; Tipo='BOOLEAN';       Nulo='NO'; Clave='';       Descripcion='true si es cambio (no genera reembolso monetario).' },
    @{ Nombre='deletedAt';  Tipo='TIMESTAMP';     Nulo='SI'; Clave='IDX';    Descripcion='Fecha de soft delete.' }
)

$sel.InsertBreak(7)

# ============================================================================
#  18. shrinkages
# ============================================================================
Add-H1 -Text "18. Tabla: shrinkages"
Add-Text -Text ("Mermas de inventario. Registra las bajas de stock que NO son ventas: productos vencidos, " +
    "rotos, hurtados o consumidos internamente. Cada merma tambien genera una fila en stock_movements " +
    "con reason=SHRINKAGE.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';           Tipo='SERIAL (PK)';   Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='product_id';   Tipo='VARCHAR';       Nulo='NO'; Clave='FK,IDX'; Descripcion='FK a products.barcode.' },
    @{ Nombre='quantity';     Tipo='DECIMAL(10,3)'; Nulo='NO'; Clave='';       Descripcion='Cantidad mermada (3 decimales para pesados).' },
    @{ Nombre='reason';       Tipo='VARCHAR(50)';   Nulo='NO'; Clave='';       Descripcion='VENCIMIENTO, ROTURA, CONSUMO_INTERNO, HURTO.' },
    @{ Nombre='cost_at_time'; Tipo='DECIMAL(10,2)'; Nulo='NO'; Clave='';       Descripcion='Costo unitario del producto al momento de la merma (para valorizar la perdida).' },
    @{ Nombre='user_id';      Tipo='VARCHAR';       Nulo='NO'; Clave='FK,IDX'; Descripcion='DNI del empleado que registro la merma.' },
    @{ Nombre='notes';        Tipo='TEXT';          Nulo='SI'; Clave='';       Descripcion='Comentarios adicionales.' },
    @{ Nombre='date';         Tipo='TIMESTAMP';     Nulo='NO'; Clave='';       Descripcion='Fecha de la merma (default now()).' },
    @{ Nombre='deletedAt';    Tipo='TIMESTAMP';     Nulo='SI'; Clave='IDX';    Descripcion='Fecha de soft delete.' }
)

Add-H3 -Text "Valores validos de reason"
Add-Bullet -Text "VENCIMIENTO - Producto vencido."
Add-Bullet -Text "ROTURA - Envase roto o dano fisico."
Add-Bullet -Text "CONSUMO_INTERNO - Uso interno del negocio (degustacion, aseo)."
Add-Bullet -Text "HURTO - Perdida por robo detectada."

# ============================================================================
#  19. missing_items
# ============================================================================
Add-H1 -Text "19. Tabla: missing_items"
Add-Text -Text ("Productos reportados como faltantes por el personal (cajeras, bodegueros). No es una " +
    "tabla de stock, sino un buzon de sugerencias para el comprador.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';           Tipo='SERIAL (PK)'; Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='product_name'; Tipo='VARCHAR';     Nulo='NO'; Clave='';       Descripcion='Nombre libre del producto reportado (puede no existir en products).' },
    @{ Nombre='status';       Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='PENDIENTE, ADQUIRIDO, AGOTADO.' },
    @{ Nombre='reported_by';  Tipo='VARCHAR';     Nulo='SI'; Clave='FK,IDX'; Descripcion='DNI del empleado que reporto.' },
    @{ Nombre='note';         Tipo='TEXT';        Nulo='SI'; Clave='';       Descripcion='Comentario del empleado.' },
    @{ Nombre='created_at';   Tipo='TIMESTAMP';   Nulo='NO'; Clave='';       Descripcion='Fecha de reporte.' },
    @{ Nombre='updated_at';   Tipo='TIMESTAMP';   Nulo='NO'; Clave='';       Descripcion='Fecha de ultima actualizacion.' },
    @{ Nombre='deletedAt';    Tipo='TIMESTAMP';   Nulo='SI'; Clave='IDX';    Descripcion='Fecha de soft delete.' }
)

$sel.InsertBreak(7)

# ============================================================================
#  20. daily_stock_snapshots
# ============================================================================
Add-H1 -Text "20. Tabla: daily_stock_snapshots"
Add-Text -Text ("Foto de cierre diaria del stock por producto. Alimentada por un cron que corre " +
    "en la noche. Permite calcular metricas de dias con stock, dias en cero y rotacion sin recorrer todo el kardex.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';            Tipo='SERIAL (PK)'; Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='product_id';    Tipo='VARCHAR(50)'; Nulo='NO'; Clave='UK,IDX'; Descripcion='FK a products.barcode. Parte de la clave unica compuesta (product_id, snapshot_date).' },
    @{ Nombre='snapshot_date'; Tipo='DATE';        Nulo='NO'; Clave='UK,IDX'; Descripcion='Fecha de la foto. Parte de la clave unica compuesta.' },
    @{ Nombre='closing_stock'; Tipo='INTEGER';     Nulo='NO'; Clave='';       Descripcion='Stock al cierre del dia.' },
    @{ Nombre='was_zero';      Tipo='BOOLEAN';     Nulo='NO'; Clave='';       Descripcion='true si el producto termino el dia en cero.' },
    @{ Nombre='created_at';    Tipo='TIMESTAMP';   Nulo='NO'; Clave='';       Descripcion='Fecha de creacion del registro.' }
)

# ============================================================================
#  21. product_restock_metrics
# ============================================================================
Add-H1 -Text "21. Tabla: product_restock_metrics"
Add-Text -Text ("Metricas de reposicion inteligente. Un cron nocturno recalcula para cada producto " +
    "sus ventas de los ultimos 30 dias, su categoria ABC (analisis de Pareto), el stock ideal segun " +
    "el lead time del proveedor y la cantidad sugerida a pedir. Es la base del modulo Smart Restock v2.")

Add-FieldsTable -Fields @(
    @{ Nombre='id';                    Tipo='SERIAL (PK)'; Nulo='NO'; Clave='PK';     Descripcion='Identificador autoincremental.' },
    @{ Nombre='product_id';            Tipo='VARCHAR';     Nulo='NO'; Clave='UK,IDX'; Descripcion='FK a products.barcode. Unico por producto.' },
    @{ Nombre='product_name';          Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='Nombre denormalizado del producto.' },
    @{ Nombre='total_sold_30d';        Tipo='INTEGER';     Nulo='SI'; Clave='';       Descripcion='Unidades vendidas en los ultimos 30 dias.' },
    @{ Nombre='days_with_stock';       Tipo='INTEGER';     Nulo='SI'; Clave='';       Descripcion='Dias con stock > 0 en los ultimos 30.' },
    @{ Nombre='days_zero_stock';       Tipo='INTEGER';     Nulo='SI'; Clave='';       Descripcion='Dias con stock = 0 en los ultimos 30 (agotado).' },
    @{ Nombre='avg_daily_sales';       Tipo='DOUBLE';      Nulo='SI'; Clave='';       Descripcion='Promedio de ventas diarias (total_sold_30d / days_with_stock).' },
    @{ Nombre='abc_category';          Tipo='CHAR(1)';     Nulo='SI'; Clave='';       Descripcion='Categoria ABC segun rotacion (A/B/C).' },
    @{ Nombre='current_stock';         Tipo='INTEGER';     Nulo='SI'; Clave='';       Descripcion='Stock actual al momento del calculo.' },
    @{ Nombre='ideal_stock';           Tipo='INTEGER';     Nulo='SI'; Clave='';       Descripcion='Stock ideal segun lead time + demanda.' },
    @{ Nombre='suggested_order_qty';   Tipo='INTEGER';     Nulo='SI'; Clave='';       Descripcion='Cantidad sugerida a pedir para llegar al stock ideal.' },
    @{ Nombre='primary_supplier_id';   Tipo='INTEGER';     Nulo='SI'; Clave='FK';     Descripcion='FK a suppliers.id. Proveedor principal detectado.' },
    @{ Nombre='supplier_name';         Tipo='VARCHAR';     Nulo='SI'; Clave='';       Descripcion='Nombre denormalizado del proveedor.' },
    @{ Nombre='supplier_lead_days';    Tipo='INTEGER';     Nulo='SI'; Clave='';       Descripcion='Lead time del proveedor en dias.' },
    @{ Nombre='unit_cost';             Tipo='DOUBLE';      Nulo='SI'; Clave='';       Descripcion='Costo unitario para calcular la inversion sugerida.' },
    @{ Nombre='calculated_at';         Tipo='TIMESTAMP';   Nulo='NO'; Clave='';       Descripcion='Fecha de la ultima recalculacion (cron nocturno).' }
)

$sel.InsertBreak(7)

# ============================================================================
#  ANEXO: Diagrama de relaciones (texto)
# ============================================================================
Add-H1 -Text "22. Anexo A - Diagrama de relaciones (resumen)"
Add-Text -Text "Vista simplificada de las relaciones entre las tablas del modulo de Inventario."

Add-H3 -Text "Nucleo del catalogo"
Add-Bullet -Text "categories (1) -----< products (N)"
Add-Bullet -Text "suppliers  (1) -----< products (N)   [proveedor principal]"
Add-Bullet -Text "products   (N) >----< suppliers (N) [via product_suppliers]"
Add-Bullet -Text "products   (1) -----< price_logs (N)"

Add-H3 -Text "Proveedores y canales"
Add-Bullet -Text "suppliers (1) -----< supplier_order_methods (N)"
Add-Bullet -Text "suppliers (1) -----< purchase_orders (N)"
Add-Bullet -Text "suppliers (1) -----< expected_orders (N)"
Add-Bullet -Text "suppliers (1) -----< confirmed_orders (N)"

Add-H3 -Text "Movimientos de stock"
Add-Bullet -Text "products (1) -----< stock_movements (N)   [KARDEX]"
Add-Bullet -Text "products (1) -----< shrinkages (N)        [mermas]"
Add-Bullet -Text "products (1) -----< returns detalle       [via return_details]"

Add-H3 -Text "Metricas y snapshots"
Add-Bullet -Text "products (1) -----< daily_stock_snapshots (N)  [foto diaria]"
Add-Bullet -Text "products (1) -----1 product_restock_metrics    [1 a 1, cron nocturno]"

Add-H3 -Text "Ordenes y ciclo de reposicion"
Add-Bullet -Text "active_purchase_list (borrador) --> confirmed_orders (enviado) --> stock_movements (recibido)"

$sel.InsertBreak(7)

# ============================================================================
#  ANEXO B: enumeraciones
# ============================================================================
Add-H1 -Text "23. Anexo B - Enumeraciones"

Add-H3 -Text "stock_movements.type"
Add-Bullet -Text "IN  - Entrada de stock (recepcion, devolucion, ajuste positivo)."
Add-Bullet -Text "OUT - Salida de stock (venta, ajuste negativo, merma)."

Add-H3 -Text "stock_movements.reason"
Add-Bullet -Text "SALE - Venta registrada al cliente."
Add-Bullet -Text "RECEPTION - Recepcion de mercancia del proveedor."
Add-Bullet -Text "RETURN - Devolucion de cliente (entrada de stock)."
Add-Bullet -Text "ADJUSTMENT - Ajuste manual del inventario (conteo fisico)."
Add-Bullet -Text "DELETE - Eliminacion de producto o correccion."
Add-Bullet -Text "SHRINKAGE - Merma (vinculada a la tabla shrinkages)."

Add-H3 -Text "shrinkages.reason"
Add-Bullet -Text "VENCIMIENTO"
Add-Bullet -Text "ROTURA"
Add-Bullet -Text "CONSUMO_INTERNO"
Add-Bullet -Text "HURTO"

Add-H3 -Text "purchase_orders.status / expected_orders.status"
Add-Bullet -Text "PENDING - Pendiente de recepcion."
Add-Bullet -Text "RECEIVED - Mercancia recibida y contabilizada."
Add-Bullet -Text "CANCELLED - Pedido anulado."

Add-H3 -Text "confirmed_orders.status / active_purchase_list.status"
Add-Bullet -Text "pending - Aun no se envio al proveedor."
Add-Bullet -Text "ordered / in_transit - Enviado, en camino."
Add-Bullet -Text "received - Recibido en tienda."

Add-H3 -Text "returns.returnType"
Add-Bullet -Text "REFUND - Reembolso monetario al cliente."
Add-Bullet -Text "EXCHANGE - Cambio por otro producto (sin devolver dinero)."

Add-H3 -Text "supplier_order_methods.type"
Add-Bullet -Text "ROUTE - Visita fisica del preventista en dias fijos."
Add-Bullet -Text "APP - Pedido por aplicacion (Pideky, Surtiapp, etc.)."

Add-H3 -Text "missing_items.status"
Add-Bullet -Text "PENDIENTE - Reportado, aun no atendido."
Add-Bullet -Text "ADQUIRIDO - Ya se compro al proveedor."
Add-Bullet -Text "AGOTADO - No se puede conseguir por ahora."

$sel.InsertBreak(7)

# ============================================================================
#  ANEXO C: Reglas de negocio globales
# ============================================================================
Add-H1 -Text "24. Anexo C - Reglas de negocio del modulo"
Add-H3 -Text "Inventario permite negativos"
Add-Text -Text ("El sistema NO bloquea ventas por stock cero o negativo. Es una decision explicita del " +
    "dueno del negocio: prefiere que la caja siga trabajando y despues cuadrar el conteo fisico, " +
    "en vez de bloquear una venta y perder al cliente.")

Add-H3 -Text "Descuentos del proveedor no bajan el costo"
Add-Text -Text ("Cuando el proveedor da un descuento (columna discount), NO se resta al costo de compra. " +
    "El campo purchasePrice guarda el costo neto ya pagado y el descuento se SUMA al margen del PVP. " +
    "Ejemplo: costo 1.331 con 20% de margen y 12% de descuento -> PVP = 1.331 * (1 + 0.20 + 0.12) = 1.757.")

Add-H3 -Text "El kardex es la fuente de verdad"
Add-Text -Text ("La columna products.quantity es un contador denormalizado que se puede reconstruir en " +
    "cualquier momento desde stock_movements. Cuando hay dudas de saldos, siempre se cruza contra " +
    "el kardex, nunca contra la columna quantity directamente.")

Add-H3 -Text "Valorizacion del inventario"
Add-Text -Text ("El sistema valoriza el inventario al costo actual (products.purchasePrice), no al costo " +
    "historico, porque stock_movements no guarda el costo del movimiento. Esta simplificacion hace que la " +
    "foto de inventario del inicio y del final de un periodo sean comparables entre si.")

Add-H3 -Text "Soft delete"
Add-Text -Text ("Ninguna tabla del inventario se borra fisicamente. El campo deletedAt (formato timestamp) " +
    "marca cuando se hizo el borrado logico; GORM ignora automaticamente los registros con deletedAt no nulo.")

# ============================================================================
#  Pie del documento
# ============================================================================
$sel.TypeParagraph()
$sel.TypeParagraph()
Add-Text -Text ("--- Fin del documento ---") -Bold $true -Alignment 1 -Size 10 -SpaceAfter 0

# ---------- Guardar ----------
Write-Host "Guardando documento en $OutputPath ..." -ForegroundColor Cyan
$wdFormatDocumentDefault = 16   # .docx
$doc.SaveAs($OutputPath, $wdFormatDocumentDefault)
$doc.Close()
$word.Quit()

} catch {
    Write-Host "" -ForegroundColor Red
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Linea: $($_.InvocationInfo.ScriptLineNumber)" -ForegroundColor Red
    Write-Host "Comando: $($_.InvocationInfo.Line.Trim())" -ForegroundColor Yellow
    try { $doc.Close($false) } catch {}
    try { $word.Quit() } catch {}
    exit 1
}

# Liberar COM
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($sel)  | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc)  | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
[GC]::Collect() | Out-Null
[GC]::WaitForPendingFinalizers() | Out-Null

if (Test-Path $OutputPath) {
    $size = (Get-Item $OutputPath).Length
    Write-Host "OK - Archivo generado: $OutputPath  ($([math]::Round($size/1KB,1)) KB)" -ForegroundColor Green
} else {
    Write-Host "ERROR - No se pudo generar el archivo" -ForegroundColor Red
    exit 1
}
