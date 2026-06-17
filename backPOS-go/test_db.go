package main
import (
    "database/sql"
    "fmt"
    _ "github.com/mattn/go-sqlite3"
)
func main() {
    db, _ := sql.Open("sqlite3", "pos.db")
    rows, _ := db.Query("SELECT id, barcode, name, type, sale_price, purchase_price, weight_value, weight_unit FROM products WHERE name LIKE '%QUESO DOBLE CREMA KG%'")
    for rows.Next() {
        var id int
        var barcode, name, typeStr, weightUnit sql.NullString
        var salePrice, purchasePrice, weightValue sql.NullFloat64
        rows.Scan(&id, &barcode, &name, &typeStr, &salePrice, &purchasePrice, &weightValue, &weightUnit)
        fmt.Printf("id:%v barcode:%v name:%v type:%v sale_price:%v purchase_price:%v weight_value:%v weight_unit:%v\n", id, barcode.String, name.String, typeStr.String, salePrice.Float64, purchasePrice.Float64, weightValue.Float64, weightUnit.String)
    }
}
