/**
 * 数据转换接口。
 *
 * @param <S> 源数据类型
 * @param <T> 目标数据类型
 */
export interface Converter<S, T> {
  /**
   * 将指定的源数据对象转换为目标数据对象。
   *
   * @param source
   *          源数据对象，传入nul将导致返回null。
   * @return 返回转换后的目标数据对象。
   */
  convert(source: S): T;
}
