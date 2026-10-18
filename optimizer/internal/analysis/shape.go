package analysis

import (
	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/checker"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
)

// resolveShapes reads the archetype shapes of an each call's storages
// argument off its static type: one shape for a storage, one per element for
// an array literal of storages. It fills site.Shapes, or records
// SHAPE_UNRESOLVED for a storage whose type does not pin its shape and
// STORAGES_DYNAMIC for storages that cannot be unrolled. Either way it adds
// the declaration files it consulted to site.DeclarationFiles.
func resolveShapes(c *checker.Checker, site *facts.Site, storages *ast.Node) {
	r := shapeResolver{checker: c, site: site}
	shapes, reason := r.argumentShapes(storages)
	if reason != facts.ReasonNone {
		site.Reasons = append(site.Reasons, reason)
		return
	}
	site.Shapes = shapes
}

type shapeResolver struct {
	checker *checker.Checker
	site    *facts.Site
}

func (r *shapeResolver) argumentShapes(arg *ast.Node) ([]facts.ArchShape, facts.Reason) {
	if arg.Kind == ast.KindArrayLiteralExpression {
		return r.elementShapes(arg.Elements())
	}
	t := r.storageType(arg)
	if shape, ok := r.storageShape(t); ok {
		return []facts.ArchShape{shape}, facts.ReasonNone
	}
	// `any` is assignable to an array, so it must not read as a storages list.
	if t.Flags()&checker.TypeFlagsAnyOrUnknown == 0 && r.checker.IsArrayLikeType(t) {
		return nil, facts.ReasonStoragesDynamic
	}
	return nil, facts.ReasonShapeUnresolved
}

// elementShapes resolves every element of an array literal of storages; a
// single element that does not resolve leaves the storages dynamic, and so
// does a spread, whose element count is not known statically even when its
// element type resolves.
func (r *shapeResolver) elementShapes(elements []*ast.Node) ([]facts.ArchShape, facts.Reason) {
	shapes := make([]facts.ArchShape, 0, len(elements))
	for _, element := range elements {
		if element.Kind == ast.KindSpreadElement {
			return nil, facts.ReasonStoragesDynamic
		}
		shape, ok := r.storageShape(r.storageType(element))
		if !ok {
			return nil, facts.ReasonStoragesDynamic
		}
		shapes = append(shapes, shape)
	}
	return shapes, facts.ReasonNone
}

// storageType returns the static type of a storage expression. The checker
// types a storage declared in another file, an imported one or a property of
// an imported object, from that file, so the declaring file is recorded.
func (r *shapeResolver) storageType(storage *ast.Node) *checker.Type {
	if file, ok := foreignValueFileName(r.checker, storage); ok {
		r.site.AddDeclarationFile(file)
	}
	return r.checker.GetTypeAtLocation(storage)
}

// storageShape returns the shape of the archetype a storage type carries. A
// type parameter resolves through its constraint; a union resolves only when
// every member has the same shape, since the view would otherwise differ per
// member.
func (r *shapeResolver) storageShape(t *checker.Type) (facts.ArchShape, bool) {
	t = r.checker.GetApparentType(t)
	if t.Flags()&checker.TypeFlagsAnyOrUnknown != 0 {
		return facts.ArchShape{}, false
	}
	if t.IsUnion() {
		return r.unionShape(t.Types())
	}
	archetype := r.property(t, "archetype")
	if archetype == nil {
		return facts.ArchShape{}, false
	}
	return r.archetypeShape(archetype)
}

func (r *shapeResolver) unionShape(members []*checker.Type) (facts.ArchShape, bool) {
	var first facts.ArchShape
	for i, member := range members {
		shape, ok := r.storageShape(member)
		if !ok {
			return facts.ArchShape{}, false
		}
		if i == 0 {
			first = shape
		} else if shape.Key() != first.Key() {
			return facts.ArchShape{}, false
		}
	}
	return first, true
}

func (r *shapeResolver) archetypeShape(archetype *checker.Type) (facts.ArchShape, bool) {
	r.addDeclarationFiles(typeSymbol(archetype))
	required, ok := r.componentList(archetype, "components")
	if !ok {
		return facts.ArchShape{}, false
	}
	optional, ok := r.componentList(archetype, "optionals")
	if !ok {
		return facts.ArchShape{}, false
	}
	return facts.ArchShape{Required: required, Optional: optional}, true
}

// componentList reads the component tuple held in the archetype property
// name. Only a tuple of required elements pins the runtime component list:
// an optional, rest, or variadic element types view slots the storage may
// not have, and among optionals it shifts every later presence bit.
func (r *shapeResolver) componentList(archetype *checker.Type, name string) ([]facts.Component, bool) {
	tuple := r.property(archetype, name)
	if tuple == nil || !checker.IsTupleType(tuple) {
		return nil, false
	}
	flags := tuple.TargetTupleType().ElementFlags()
	components := make([]facts.Component, 0, len(flags))
	// A tuple reference's type arguments may end with its `this` type.
	for i, element := range r.checker.GetTypeArguments(tuple)[:len(flags)] {
		if flags[i] != checker.ElementFlagsRequired {
			return nil, false
		}
		component, ok := r.component(element)
		if !ok {
			return nil, false
		}
		components = append(components, component)
	}
	return components, true
}

// component reads a component type: its name from `__ecstatic_name`, which
// must be a single string literal, and its fields. A relation's fields come
// from its relation meta, which never lists `target`.
func (r *shapeResolver) component(t *checker.Type) (facts.Component, bool) {
	name, ok := stringLiteral(r.property(t, "__ecstatic_name"))
	if !ok {
		return facts.Component{}, false
	}
	meta := r.property(t, "__ecstatic_relation_meta")
	relation := meta != nil
	if !relation {
		meta = r.property(t, "__ecstatic_component_meta")
	}
	if meta == nil {
		return facts.Component{}, false
	}
	// The component meta is declared optional, so its type includes undefined.
	fieldsType := r.property(r.checker.GetNonNullableType(meta), "fields")
	if fieldsType == nil {
		return facts.Component{}, false
	}
	return facts.Component{Name: name, Fields: r.fields(fieldsType), Relation: relation}, true
}

// stringLiteral returns the value of a single string literal type, and false
// for any other type, a union of literals or plain `string` among them.
func stringLiteral(t *checker.Type) (string, bool) {
	if t == nil || t.Flags()&checker.TypeFlagsStringLiteral == 0 {
		return "", false
	}
	value, ok := t.AsLiteralType().Value().(string)
	return value, ok
}

// fields lists the properties of a component's fields type in declaration
// order, each with the column kind its value type is stored in.
func (r *shapeResolver) fields(t *checker.Type) []facts.Field {
	properties := propertiesOfType(r.checker, t)
	fields := make([]facts.Field, 0, len(properties))
	for _, property := range properties {
		r.addDeclarationFiles(property)
		fields = append(fields, facts.Field{
			Name: symbolName(property),
			Kind: fieldKind(r.checker, typeOfSymbol(r.checker, property)),
		})
	}
	return fields
}

// fieldKind maps a field's value type to its column: boolean and number get
// numeric columns, anything else, `undefined`-including unions among them, a
// plain array.
func fieldKind(c *checker.Checker, t *checker.Type) facts.FieldKind {
	base := c.GetBaseTypeOfLiteralType(t)
	switch {
	case base.Flags()&checker.TypeFlagsBoolean != 0:
		return facts.FieldBoolean
	case base.Flags()&checker.TypeFlagsNumber != 0:
		return facts.FieldNumber
	default:
		return facts.FieldPlain
	}
}

// property returns the type of t's property name, nil when t has none, and
// adds the files declaring the property to the site's declaration files.
func (r *shapeResolver) property(t *checker.Type, name string) *checker.Type {
	symbol := propertyOfType(r.checker, t, name)
	if symbol == nil {
		return nil
	}
	r.addDeclarationFiles(symbol)
	return typeOfSymbol(r.checker, symbol)
}

func (r *shapeResolver) addDeclarationFiles(symbol *ast.Symbol) {
	for _, file := range declarationFileNames(symbol) {
		r.site.AddDeclarationFile(file)
	}
}
