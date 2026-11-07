/** components/tag-pill —— 标签胶囊（契约 §5.4）。归属：C 岗；A 只保结构可编译。 */
Component({
  properties: {
    text: { type: String, value: '' },
    type: { type: String, value: 'default' } // default | warn
  }
});
