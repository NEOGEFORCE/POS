package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// FactusErrorResponse is the structure expected by the frontend for Factus 422 errors
type FactusErrorResponse struct {
	Message string                 `json:"message"`
	Errors  map[string]interface{} `json:"errors"`
}

// FactusValidationMiddleware intercepts errors and formats them into Factus-compatible 422 JSON
func FactusValidationMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()

		if len(c.Errors) > 0 {
			// If we specifically set 422 or if it's a validation error
			if c.Writer.Status() == http.StatusUnprocessableEntity {
				var errMap = make(map[string]interface{})
				for _, err := range c.Errors {
					errMap["validation"] = append(errMap["validation"].([]string), err.Error())
				}
				c.JSON(http.StatusUnprocessableEntity, FactusErrorResponse{
					Message: "The given data was invalid.",
					Errors:  errMap,
				})
			}
		}
	}
}
